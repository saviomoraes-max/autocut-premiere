// Orquestração do fluxo Auto-Edit (modo ACHATADO, pares vídeo+áudio):
//   readSegments -> /transcribe (áudio A1) -> /analyze -> (revisão humana)
//   -> computeKeeps (achatado) -> mapKeepsToSourceSlices -> applyRoughCut (V1 vídeo + A1 áudio)
import { computeKeeps } from "../../../shared/cuts";
import {
  layoutSegments,
  mapKeepsToSourceSlices,
  remapFlatTimesToTimeline,
  type SourceSlice,
} from "../../../shared/segments";
import {
  buildBlocks,
  retakeCutForBlock,
  restrictKeepsToWindow,
  type Block,
} from "../../../shared/blocks";
import { mapZoomKeysToClips } from "../../../shared/zoom";
import type {
  CaptionStyle,
  Cut,
  Marker,
  RetakeSignal,
  TranscriptResult,
  ZoomPoint,
} from "../../../shared/types";
import { BackendClient } from "../api/backendClient";
import {
  readSegments,
  readAudioSegments,
  resolveClipsByPath,
  type TimelineSegment,
} from "../premiere/selection";
import { applyRoughCut, type PlacedSlice } from "../premiere/applyCuts";
import { applyZooms, type ZoomDiagEvent } from "../premiere/applyZooms";

export interface StatusCallback {
  (msg: string): void;
}

/** Cortes propostos + tudo que a etapa de aplicação vai precisar. */
export interface Proposal {
  /** Pares (vídeo+áudio) lidos da timeline, em ordem (índice casa com o stream achatado). */
  segments: TimelineSegment[];
  source: "selection" | "sequence";
  transcript: TranscriptResult;
  cuts: Cut[];
  /** Marcadores falados detectados (fronteiras de bloco candidatas). */
  markers: Marker[];
  /** Sinais de retake detectados na fala do chefe. */
  retakeSignals: RetakeSignal[];
  /** Pontos de zoom (punch-in) detectados na transcrição. */
  zoomPoints: ZoomPoint[];
  /** Duração total do stream achatado (s). */
  durationSec: number;
  /** Frame rate da sequência (igual em todos os segmentos). */
  fps: number;
}

/** Lê os pares, transcreve o áudio A1 e analisa — devolve os cortes propostos para revisão. */
export async function proposeCuts(
  client: BackendClient,
  userPrompt: string | undefined,
  onStatus: StatusCallback,
  signal?: AbortSignal,
  /** Preset de respiro: pausa mínima (s) que vira corte (Seco pega pausas mais curtas). */
  silence?: { minSilenceSec?: number },
): Promise<Proposal> {
  onStatus("Lendo os clipes na timeline…");
  const read = await readSegments();
  const segments = read.segments;
  const fps = segments[0].audio.clipRef.fps;
  // Transcreve o ÁUDIO da trilha A1 (o áudio real).
  const audioRefs = segments.map((s) => s.audio.clipRef);

  // DIAGNÓSTICO: como os pares foram lidos (n, in/out de áudio e vídeo, span de timeline).
  await client.debug("read-segments", {
    source: read.source,
    fps,
    count: segments.length,
    segments: segments.map((s, i) => ({
      i,
      tl: [round(s.timelineStartSec), round(s.timelineEndSec)],
      audio: { f: base(s.audio.clipRef.mediaPath), in: round(s.audio.clipRef.inSec), out: round(s.audio.clipRef.outSec), dur: round(s.audio.clipRef.outSec - s.audio.clipRef.inSec) },
      video: { f: base(s.video.clipRef.mediaPath), in: round(s.video.clipRef.inSec), out: round(s.video.clipRef.outSec), dur: round(s.video.clipRef.outSec - s.video.clipRef.inSec) },
    })),
  });

  const fonte = read.source === "selection" ? "seleção" : "sequência inteira";
  onStatus(`Transcrevendo o áudio de ${segments.length} clipe(s) (${fonte})…`);
  // NÃO manda o userPrompt (instrução de corte) pro Whisper — enviesava a transcrição. O
  // vocabulário-guia da transcrição vem da config (domínio). userPrompt vai só pra ANÁLISE.
  const t = await client.transcribe(audioRefs, { signal });

  onStatus("Analisando cortes com a IA…");
  const a = await client.analyze({ transcript: t.transcript, segments: audioRefs, userPrompt, silence, signal });

  return {
    segments,
    source: read.source,
    transcript: t.transcript,
    cuts: a.cuts,
    markers: a.markers ?? [],
    retakeSignals: a.retakeSignals ?? [],
    zoomPoints: a.zoomPoints ?? [],
    durationSec: t.transcript.durationSec,
    fps,
  };
}

/**
 * EXPORTAR SRT: transcreve a seleção/sequência e gera o .srt no padrão do plugin Legendas
 * RECONECTA (preset Create Captions + dinheiro/nomes). Devolve o texto do .srt — quem salva
 * é o painel (seletor de arquivo do UXP). Mais leve que o propose: só lê + transcreve.
 */
export async function exportSrt(
  client: BackendClient,
  onStatus: StatusCallback,
  signal?: AbortSignal,
  /** Sincronia (s): >0 ATRASA a legenda, <0 ADIANTA. Vira leadSec = -atrasoSec. */
  atrasoSec = 0,
  /** Estilo da legenda escolhido no painel: "reels" (dinâmica) ou "cinema" (frase inteira). */
  style: CaptionStyle = "reels",
): Promise<{ srt: string; count: number }> {
  onStatus("Lendo os clipes na timeline…");
  // SRT lê TODO o áudio da A1 (sem exigir par de vídeo) — pra nenhum clip de áudio com fala
  // sumir do SRT (era a causa do buraco de legenda no meio). Auto-Edit continua usando readSegments.
  const read = await readAudioSegments();
  const segments = read.segments;
  const audioRefs = segments.map((s) => s.audio.clipRef);
  const fonte = read.source === "selection" ? "seleção" : "sequência inteira";

  onStatus(`Transcrevendo o áudio de ${segments.length} clipe(s) (${fonte})…`);
  // Legenda pede o texto LIMPO (número em algarismo, sem hesitação nem "--"). Com o WhisperX
  // não muda nada; com o ElevenLabs escolhe o modo no_verbatim. O corte continua no literal.
  const t = await client.transcribe(audioRefs, { signal, verbatim: false });

  // DIAGNÓSTICO de cobertura: quanto áudio entrou vs quanto foi transcrito + os maiores buracos
  // de palavra (gap no transcript ACHATADO = trecho de fala que o WhisperX/VAD não pegou).
  const durTotal = audioRefs.reduce((a, c) => a + (c.outSec - c.inSec), 0);
  const words = t.transcript.words;
  const gaps: Array<{ de: number; a: number; gap: number }> = [];
  for (let i = 1; i < words.length; i++) {
    const g = words[i].start - words[i - 1].end;
    if (g >= 3) gaps.push({ de: Math.round(words[i - 1].end * 10) / 10, a: Math.round(words[i].start * 10) / 10, gap: Math.round(g * 10) / 10 });
  }
  gaps.sort((x, y) => y.gap - x.gap);
  await client.debug("srt-cobertura", {
    clipsAudioA1Total: read.totalAudioClips,
    clipsComMidia: segments.length,
    pulados: read.totalAudioClips - segments.length,
    durAudioSomada: Math.round(durTotal * 10) / 10,
    transcriptDur: Math.round(t.transcript.durationSec * 10) / 10,
    palavras: words.length,
    buracosNoTranscript: gaps.slice(0, 8),
  });

  onStatus("Montando as legendas (.srt)…");
  // REMAP achatado→timeline: cada palavra é mapeada pro tempo REAL do seu clip na timeline
  // (clip a clip), em vez de um offset único que assumia clips contíguos. Conserta também o
  // desalinhamento quando os clips têm gaps/cortes entre si na timeline.
  const placements = segments.map((s) => ({
    flatDurSec: s.audio.clipRef.outSec - s.audio.clipRef.inSec,
    timelineStartSec: s.timelineStartSec,
  }));
  const wordsTimeline = remapFlatTimesToTimeline(words, placements);
  // lead>0 adianta; o usuário pensa em ATRASO (positivo) → leadSec = -atraso. offset já embutido.
  // O fps da sequência vai junto: o estilo cinema mede o gap entre legendas em FRAMES.
  return client.srt(wordsTimeline, {
    offsetSec: 0,
    leadSec: -atrasoSec,
    style,
    fps: segments[0]?.audio.clipRef.fps,
    signal,
  });
}

/**
 * AUTO-ZOOM (opção B): aplica os gestos de zoom APROVADOS direto nos clips da V1.
 * Mapeia os keyframes (tempo achatado) → clip + tempo relativo, relê os clipes frescos e
 * keyframa a Escala do Transformar em cada clip. Devolve quantos clips receberam zoom.
 */
export async function applyZoomPoints(
  client: BackendClient,
  proposal: Proposal,
  approvedZooms: ZoomPoint[],
  onStatus: StatusCallback,
): Promise<{ applied: number; diag: ZoomDiagEvent[] }> {
  // Coleta o diagnóstico em memória (a UI mostra) E tenta o canal /debug (que pode falhar).
  const diag: ZoomDiagEvent[] = [];
  const push = (label: string, data: unknown): void => {
    diag.push({ label, data });
    void client.debug(`[zoom] ${label}`, data);
  };

  if (!approvedZooms.length) throw new Error("Nenhum zoom selecionado.");

  // Layout achatado pela duração do ÁUDIO (mesmo domínio da transcrição/zoom).
  const layout = layoutSegments(
    proposal.segments.map((s) => ({ flatDurSec: s.audio.clipRef.outSec - s.audio.clipRef.inSec })),
  );
  const clipZooms = mapZoomKeysToClips(approvedZooms, layout.laid);
  push("orquestra", {
    approvedZooms: approvedZooms.length,
    clipZooms: clipZooms.length,
    laidSegs: layout.laid.length,
    totalSec: layout.totalSec,
    porClip: clipZooms.map((c) => ({ seg: c.segmentIndex, keys: c.keys.length })),
  });
  if (!clipZooms.length) throw new Error("Os zooms não caíram em nenhum clip.");

  // Relê FRESCO (handles do UXP expiram) e confere que os clipes não mudaram.
  onStatus("Relendo os clipes na timeline…");
  const fresh = await readSegments();
  const same = sameSegments(proposal.segments, fresh.segments);
  push("fresh", { same, freshSegs: fresh.segments.length, propSegs: proposal.segments.length });
  if (!same) {
    throw new Error("Os clipes mudaram desde a análise. Refaça e tente de novo.");
  }

  onStatus(`Aplicando zoom em ${clipZooms.length} clip(s)…`);
  const res = await applyZooms(clipZooms, fresh.segments, {
    onDebug: (label, data) => client.debug(`[zoom] ${label}`, data),
  });
  diag.push(...res.diag);
  return { applied: res.applied, diag };
}

/** Aplica só os cortes aprovados, montando o Rough Cut (vídeo+áudio). Devolve o nome da sequência. */
/** Margens de respiro em volta de cada corte (preset Seco/Natural/Suave do painel). */
export interface RespiroPad {
  startSec: number;
  endSec: number;
}

export async function applyApprovedCuts(
  client: BackendClient,
  proposal: Proposal,
  approvedCuts: Cut[],
  onStatus: StatusCallback,
  pad?: RespiroPad,
): Promise<string> {
  // 1. Layout achatado pela duração do ÁUDIO (= o que foi concatenado/transcrito).
  const layout = layoutSegments(
    proposal.segments.map((s) => ({ flatDurSec: s.audio.clipRef.outSec - s.audio.clipRef.inSec })),
  );

  // 2. Keeps em tempo ACHATADO (offset 0), limitados pela duração geométrica do stream.
  const keeps = computeKeeps(approvedCuts, layout.totalSec, {
    fps: proposal.fps,
    sourceOffsetSec: 0,
    padStartSec: pad?.startSec,
    padEndSec: pad?.endSec,
  });
  if (!keeps.length) {
    throw new Error("Todos os trechos foram cortados — nada para montar.");
  }

  // 3. Mapeia keeps -> fatias (offset relativo ao segmento; corta nas fronteiras).
  const slices = mapKeepsToSourceSlices(keeps, layout.laid, { fps: proposal.fps });
  if (!slices.length) {
    throw new Error("Nada para montar após mapear as fatias.");
  }

  // 4. Re-lê FRESCO: handles do UXP podem expirar e a seleção pode ter mudado.
  onStatus("Relendo os clipes na timeline…");
  const fresh = await readSegments();
  if (!sameSegments(proposal.segments, fresh.segments)) {
    throw new Error(
      "Os clipes mudaram desde o Auto-Edit. Refaça a seleção (ou rode na sequência) e tente de novo.",
    );
  }

  // 5. Handles FRESCOS do bin (os da timeline expiram) e posiciona as fatias na saída.
  await refreshSegmentHandles(fresh.segments);
  const { placed, segIdx } = buildPlacedSlices(slices, fresh.segments, proposal.fps);

  // DIAGNÓSTICO: o plano de montagem (posição na saída + dur de vídeo vs áudio + gaps).
  await client.debug("apply-plan", {
    totalSec: round(layout.totalSec),
    keeps: keeps.map((k) => [round(k.start), round(k.end)]),
    slices: placed.map((p, i) => {
      const vdur = p.video.endSec - p.video.startSec;
      const adur = p.audio.endSec - p.audio.startSec;
      return {
        i,
        seg: segIdx[i],
        outPos: round(p.outStartSec),
        video: [round(p.video.startSec), round(p.video.endSec), `dur ${round(vdur)}`],
        audio: [round(p.audio.startSec), round(p.audio.endSec), `dur ${round(adur)}`],
        sync: Math.abs(vdur - adur) < 0.02 ? "ok" : `DIVERGE ${round(vdur - adur)}`,
      };
    }),
  });

  onStatus("Montando o rough cut (vídeo + áudio) na timeline…");
  return applyRoughCut(placed, { fps: proposal.fps, onDebug: (label, data) => client.debug(label, data) });
}

/**
 * Re-resolve os handles (clip/projectItem) dos segmentos DIRETO do bin, por caminho de mídia.
 * Um handle capturado da timeline "expira" no UXP depois de criar uma sequência
 * (createSequenceFromMedia) → "The script object is no longer valid" na fatia0 do próximo bloco.
 * O bin é durável; re-buscar dele ANTES de montar cada bloco dá handles sempre válidos. Muta os
 * segmentos em lugar (buildPlacedSlices lê seg.video.clip na hora). Se um caminho não for achado
 * no bin, mantém o handle atual (melhor tentar do que abortar).
 */
async function refreshSegmentHandles(segments: TimelineSegment[]): Promise<{ resolved: number; total: number }> {
  const paths = new Set<string>();
  for (const s of segments) {
    paths.add(s.video.clipRef.mediaPath);
    paths.add(s.audio.clipRef.mediaPath);
  }
  const byPath = await resolveClipsByPath(paths);
  for (const s of segments) {
    const v = byPath.get(s.video.clipRef.mediaPath);
    const a = byPath.get(s.audio.clipRef.mediaPath);
    if (v) {
      s.video.clip = v.clip;
      s.video.projectItem = v.projectItem;
    }
    if (a) {
      s.audio.clip = a.clip;
      s.audio.projectItem = a.projectItem;
    }
  }
  return { resolved: byPath.size, total: paths.size };
}

/**
 * Posiciona as fatias na saída com posição DETERMINÍSTICA. Lógica validada:
 *   - dentro de um clipe, as fatias ficam contíguas (respiros removidos);
 *   - entre clipes, preserva só o GAP VAZIO original (next.start - prev.end), nunca o
 *     corpo de um clipe cortado por inteiro;
 *   - TRAVA DE FRAME (A/V sync): posição e duração snapadas em frame, MESMA duração pras
 *     duas trilhas → bordas de vídeo e áudio caem no mesmo frame.
 * A 1ª fatia começa em outPos 0 (âncora) — por isso CADA bloco/janela vira uma sequência
 * que começa do zero. Descarta fatia degenerada (0 frame). Devolve também o índice de
 * segmento de cada fatia (pro diagnóstico).
 */
function buildPlacedSlices(
  slices: ReadonlyArray<SourceSlice>,
  fresh: TimelineSegment[],
  fps: number,
): { placed: PlacedSlice[]; segIdx: number[] } {
  const snap = (t: number) => Math.round(t * fps) / fps;
  let outPos = 0;
  let prevSegIdx = -1;
  const placed: PlacedSlice[] = [];
  const segIdx: number[] = [];

  for (const sl of slices) {
    const seg = fresh[sl.segmentIndex];
    if (prevSegIdx !== -1 && sl.segmentIndex !== prevSegIdx) {
      let gap = 0;
      for (let k = prevSegIdx; k < sl.segmentIndex; k++) {
        gap += Math.max(0, fresh[k + 1].timelineStartSec - fresh[k].timelineEndSec);
      }
      outPos += gap;
    }
    const outStartSec = snap(outPos);
    const vStart = snap(seg.video.clipRef.inSec + sl.relStartSec);
    const aStart = snap(seg.audio.clipRef.inSec + sl.relStartSec);
    const dur = Math.max(
      0,
      Math.min(
        snap(sl.relEndSec) - snap(sl.relStartSec),
        snap(seg.video.clipRef.outSec) - vStart,
        snap(seg.audio.clipRef.outSec) - aStart,
      ),
    );
    outPos = outStartSec + dur;
    prevSegIdx = sl.segmentIndex;
    if (dur <= 1e-6) continue; // descarta fatia degenerada (0 frame)
    placed.push({
      outStartSec,
      video: {
        clip: seg.video.clip,
        projectItem: seg.video.projectItem,
        mediaPath: seg.video.clipRef.mediaPath,
        startSec: vStart,
        endSec: vStart + dur,
      },
      audio: {
        clip: seg.audio.clip,
        projectItem: seg.audio.projectItem,
        mediaPath: seg.audio.clipRef.mediaPath,
        startSec: aStart,
        endSec: aStart + dur,
      },
    });
    segIdx.push(sl.segmentIndex);
  }

  // REANCORAGEM: applyRoughCut deposita a fatia 0 na posição 0 da sequência nova (Fase 1) e
  // depois reescreve a MESMA mídia em outStartSec[0] (Fase 2). Se a 1ª fatia REAL não cair em
  // 0 (ex.: a fatia 0 saiu degenerada e empurrou o gap), o overwrite não cobre a cópia da
  // Fase 1 → fatia-fantasma no início. Reancora subtraindo o offset (snap preserva frame; os
  // tempos de mídia vStart/aStart não mudam, só a posição na saída).
  if (placed.length && placed[0].outStartSec > 1e-6) {
    const base = placed[0].outStartSec;
    for (const p of placed) p.outStartSec = snap(p.outStartSec - base);
  }

  return { placed, segIdx };
}

/**
 * SEGMENTAÇÃO (opção A): cria UMA sequência por bloco confirmado. Cada bloco é uma janela
 * de tempo achatado; o motor de corte/sync é o mesmo do rough cut, só que escopado à janela
 * — e a fatia 0 de cada bloco começa em 0, então cada sequência fica autocontida.
 *
 * Por que isso MATA o crash: nunca aplica os 500+ cortes do bruto inteiro de uma vez; cada
 * sequência tem só dezenas de fatias (uma peça de 1–5 min). Escala pequena = sem bulk-edit.
 *
 * Lê os segmentos UMA vez (clip/ProjectItem do bin são duráveis) e reaproveita pra todos os
 * blocos. Cortes = silêncio/filler aprovados + corte de retake por bloco (sinais habilitados).
 */
export async function applyBlockSequences(
  client: BackendClient,
  proposal: Proposal,
  blocks: Block[],
  approvedFineCuts: Cut[],
  enabledSignals: RetakeSignal[],
  onStatus: StatusCallback,
  pad?: RespiroPad,
): Promise<string[]> {
  if (!blocks.length) throw new Error("Nenhum bloco para montar.");

  const layout = layoutSegments(
    proposal.segments.map((s) => ({ flatDurSec: s.audio.clipRef.outSec - s.audio.clipRef.inSec })),
  );

  // Cortes finos (silêncio/filler) + um corte de retake por bloco. Tudo em tempo achatado.
  const retakeCuts = blocks
    .map((b) => retakeCutForBlock(b, enabledSignals))
    .filter((c): c is Cut => c !== null);
  const allCuts = [...approvedFineCuts, ...retakeCuts];
  const keepsAll = computeKeeps(allCuts, layout.totalSec, {
    fps: proposal.fps,
    sourceOffsetSec: 0,
    padStartSec: pad?.startSec,
    padEndSec: pad?.endSec,
  });

  // Lê FRESCO uma vez e confere que os clipes não mudaram desde o Auto-Edit.
  onStatus("Relendo os clipes na timeline…");
  const fresh = await readSegments();
  if (!sameSegments(proposal.segments, fresh.segments)) {
    throw new Error(
      "Os clipes mudaram desde o Auto-Edit. Refaça a seleção (ou rode na sequência) e tente de novo.",
    );
  }

  await client.debug("block-plan", {
    totalSec: round(layout.totalSec),
    blocks: blocks.map((b) => ({ label: b.label, win: [round(b.startSec), round(b.endSec)] })),
    retakeCuts: retakeCuts.map((c) => [round(c.start), round(c.end)]),
  });

  const names: string[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const keeps = restrictKeepsToWindow(keepsAll, block.startSec, block.endSec);
    // Piso: bloco com quase nada mantido (ex.: take inteiro descartado por retake) NÃO vira
    // sequência — evita uma sequência-lixo de poucos frames poluindo o projeto.
    const mantidoSec = keeps.reduce((a, k) => a + (k.end - k.start), 0);
    if (mantidoSec < 0.3) {
      await client.debug("block-vazio", { label: block.label, mantidoSec: round(mantidoSec) });
      continue; // bloco inteiro caiu (tudo cortado) — não gera sequência
    }
    const slices = mapKeepsToSourceSlices(keeps, layout.laid, { fps: proposal.fps });
    // Handles FRESCOS do bin ANTES de cada bloco (bin é durável; independe da seq ativa).
    const ref = await refreshSegmentHandles(fresh.segments);
    const { placed } = buildPlacedSlices(slices, fresh.segments, proposal.fps);
    if (!placed.length) continue;

    onStatus(`Montando ${bi + 1}/${blocks.length}: ${block.label}…`);
    try {
      const name = await applyRoughCut(placed, {
        sequenceName: block.label,
        fps: proposal.fps,
        onDebug: (label, data) => client.debug(`[${block.label}] ${label}`, data),
      });
      names.push(name);
    } catch (e) {
      // Contexto no erro (o log não recebe o debug do apply): bloco + quantos handles o bin resolveu.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Bloco ${bi + 1}/${blocks.length} "${block.label}" (bin ${ref.resolved}/${ref.total}): ${msg}`);
    }
  }

  if (!names.length) {
    throw new Error("Nenhum bloco gerou conteúdo — confira os marcadores e os cortes.");
  }
  return names;
}

/** Arredonda pra 3 casas (legibilidade do log de diagnóstico). */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Nome do arquivo (basename) — pra não poluir o log com o caminho inteiro. */
function base(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Os pares frescos batem (mídia + in/out de vídeo E áudio, índice a índice) com a proposta? */
function sameSegments(a: TimelineSegment[], b: TimelineSegment[]): boolean {
  if (a.length !== b.length) return false;
  const same = (x: TimelineSegment["video"], y: TimelineSegment["video"]) =>
    x.clipRef.mediaPath === y.clipRef.mediaPath &&
    Math.abs(x.clipRef.inSec - y.clipRef.inSec) <= 0.001 &&
    Math.abs(x.clipRef.outSec - y.clipRef.outSec) <= 0.001;
  for (let i = 0; i < a.length; i++) {
    if (!same(a[i].video, b[i].video)) return false;
    if (!same(a[i].audio, b[i].audio)) return false;
  }
  return true;
}
