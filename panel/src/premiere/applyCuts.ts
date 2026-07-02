// Aplica os cortes montando uma sequência "Rough Cut" NÃO-DESTRUTIVA, com VÍDEO no V1
// e o ÁUDIO REAL no A1, em sincronia.
//
// Como o áudio real costuma ser um arquivo separado (vinculado ao vídeo), montar em duas
// trilhas tem 3 fases:
//   1. createSequenceFromMedia a partir do 1º clipe de VÍDEO → herda settings (res/fps) e
//      deita a 1ª fatia de vídeo (com o áudio EMBUTIDO da câmera no A1, que será trocado).
//   2. Anexa as demais fatias de vídeo no FIM atual da sequência (sem drift), guardando a
//      posição de início de cada fatia.
//   3. SOBRESCREVE (overwrite, sem ripple) o áudio real no A1 em cada posição — substitui
//      o áudio de câmera pelo áudio do A1, na mesma posição/duração.
//
// Provado no caso 1 clipe: createSequenceFromMedia respeita in/out; insert exige
// lockedAccess(executeTransaction). Uma transação por item = determinístico (sem o risco
// de in/out interleaved). O clip/ProjectItem do bin são DURÁVEIS.
//
// FALLBACK vídeo-só: se o overwrite de áudio brigar no Premiere, basta pular a fase 3
// (a sequência sai como vídeo + áudio de câmera).
import type { Action, ClipProjectItem, FrameRate, ProjectItem } from "@adobe/premierepro";
import { ppro, requireActiveProject, tt } from "./ppro";
import { resolveClipsByPath } from "./selection";

/** Uma fonte (vídeo ou áudio) com o trecho da mídia de origem a depositar. */
export interface SliceSource {
  clip: ClipProjectItem;
  projectItem: ProjectItem;
  /** Caminho da mídia — pra RE-RESOLVER o clipe na instância de Project que roda a transação. */
  mediaPath: string;
  startSec: number;
  endSec: number;
}

/** Uma fatia do rough cut: o mesmo trecho temporal nas duas trilhas, numa posição fixa. */
export interface PlacedSlice {
  /** Posição de início desta fatia na sequência de saída (s) — já com os gaps preservados. */
  outStartSec: number;
  video: SliceSource;
  audio: SliceSource;
}

export interface ApplyOptions {
  sequenceName?: string;
  /** Pula a fase 3 (áudio real no A1) — sai como vídeo + áudio de câmera. */
  videoOnly?: boolean;
  /** Frame rate (do proposal) pra criar TickTime em FRAME já na Fase 1 (evita o erro de seg→tick). */
  fps?: number;
  /** Canal de diagnóstico: recebe o que foi REALMENTE montado (V1/A1 lidos de volta). */
  onDebug?: (label: string, data: unknown) => Promise<void> | void;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Lê de volta os clipes de uma trilha da sequência montada (posição/duração/in-out reais). */
async function readBackTrack(
  track: { getTrackItems: (t: number, e: boolean) => Promise<Array<{ getStartTime: () => Promise<{ seconds: number }>; getEndTime: () => Promise<{ seconds: number }>; getInPoint: () => Promise<{ seconds: number }>; getOutPoint: () => Promise<{ seconds: number }> }>> },
): Promise<Array<{ pos: number; end: number; dur: number; in: number; out: number }>> {
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const rows = [];
  for (const it of items) {
    const pos = (await it.getStartTime()).seconds;
    const end = (await it.getEndTime()).seconds;
    const inn = (await it.getInPoint()).seconds;
    const out = (await it.getOutPoint()).seconds;
    rows.push({ pos: r3(pos), end: r3(end), dur: r3(end - pos), in: r3(inn), out: r3(out) });
  }
  return rows;
}

// Roda uma etapa rotulada: se quebrar, o erro diz QUAL chamada falhou.
async function step<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`AC> FALHOU em [${label}]: ${msg}`);
    throw new Error(`[${label}] ${msg}`);
  }
}

export async function applyRoughCut(slices: PlacedSlice[], opts: ApplyOptions = {}): Promise<string> {
  if (!slices.length) {
    throw new Error("Nenhuma fatia para manter — nada a montar.");
  }

  const project = await step("getActiveProject", () => requireActiveProject());

  // PR26 — objetos ClipProjectItem "expiram" (a) quando vêm de OUTRA instância de Project e
  // (b) DEPOIS que createSequenceFromMedia reestrutura o projeto. Re-resolvo os clipes desta
  // MESMA instância `project`, por caminho de mídia — chamado no INÍCIO e DE NOVO após criar a
  // sequência. Se algum caminho não achar no bin, mantém o handle atual.
  const reResolveSlices = async (): Promise<void> => {
    const paths = new Set<string>();
    for (const sl of slices) {
      paths.add(sl.video.mediaPath);
      paths.add(sl.audio.mediaPath);
    }
    const byPath = await resolveClipsByPath(paths, project);
    for (const sl of slices) {
      const v = byPath.get(sl.video.mediaPath);
      const a = byPath.get(sl.audio.mediaPath);
      if (v) {
        sl.video.clip = v.clip;
        sl.video.projectItem = v.projectItem;
      }
      if (a) {
        sl.audio.clip = a.clip;
        sl.audio.projectItem = a.projectItem;
      }
    }
  };
  try {
    await reResolveSlices();
  } catch (e) {
    console.log("AC> re-resolve inicial falhou (segue com os handles atuais):", e);
  }

  // Rede de segurança PR26: se um objeto de clipe expirar no meio de uma ação, re-resolve os
  // clipes (mesma instância) e refaz a ação UMA vez. Cobre o caso de o overwrite/setInOut
  // invalidar o clipe entre as fatias.
  const isStale = (e: unknown): boolean =>
    String(e instanceof Error ? e.message : e).includes("no longer valid");
  const stepRetry = async <T>(label: string, fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await step(label, fn);
    } catch (e) {
      if (!isStale(e)) throw e;
      await reResolveSlices();
      return await step(`${label} (retry)`, fn);
    }
  };

  const firstName = await step("ler clip.name", () => slices[0].video.clip.name);
  const nome =
    opts.sequenceName ??
    (slices.length > 1 ? `Rough Cut - ${firstName} (+${slices.length - 1})` : `Rough Cut - ${firstName}`);
  console.log("AC> rough cut:", nome, "| fatias:", slices.length, "| videoOnly:", !!opts.videoOnly);

  // ----- Fase 1: cria a sequência a partir da 1ª fatia de vídeo (settings + 1ª fatia em 0). -----
  // Posições são DETERMINÍSTICAS (slice.outStartSec), com os gaps entre clipes preservados.
  // A fatia 0 começa em 0 (a âncora é o início do 1º clipe); as demais vão na posição exata.
  const first = slices[0];

  // TickTime em FRAME (segundos dá "seg->tick" inválido no PR26). fr0 = FrameRate do proposal.
  let fr0: FrameRate | null = null;
  try {
    if (opts.fps && opts.fps > 0) fr0 = ppro.FrameRate.createWithValue(opts.fps);
  } catch {
    fr0 = null;
  }
  const frTT = (sec: number): import("@adobe/premierepro").TickTime =>
    ppro.TickTime.createWithFrameAndFrameRate(Math.round(sec * (opts.fps as number)), fr0 as FrameRate);

  // MOTOR de setInOut robusto (PR26). O setInOut no project item quebrou no Premiere 2026 de uma
  // forma específica — então tenta COMBINAÇÕES (frame/seg × combinado/separado × com/sem lock),
  // re-resolvendo o clipe em "no longer valid". A 1ª que passa vira o PADRÃO (winMode), testado
  // primeiro nas próximas fatias (não re-testa tudo 316×). Usado na Fase 1 E na 2/3 — a Fase 2
  // falhava por usar a chamada crua em vez da combinação que venceu.
  type Mode = { tick: "frame" | "seg"; sep: boolean; locked: boolean; label: string };
  const allModes: Mode[] = [];
  for (const locked of [false, true])
    for (const sep of [false, true])
      for (const tick of ["frame", "seg"] as const)
        if (tick === "seg" || fr0)
          allModes.push({ tick, sep, locked, label: `${sep ? "in+out" : "inout"}-${tick}${locked ? "+lock" : ""}` });
  let winMode: Mode | null = null;

  // mkIO(tick, sep) monta as ações de in/out pra um clipe/trecho — o chamador injeta o clipe e os
  // tempos. Lê o clipe SEMPRE na hora (pra pegar o re-resolvido). Devolve nome da combinação usada.
  const robustSetInOut = async (
    mkIO: (tick: "frame" | "seg", sep: boolean) => Action[],
    label: string,
  ): Promise<void> => {
    const runMode = async (m: Mode): Promise<void> => {
      const tx = () =>
        project.executeTransaction((ca) => {
          for (const a of mkIO(m.tick, m.sep)) ca.addAction(a);
        }, "AutoCut: in/out");
      if (m.locked) await project.lockedAccess(tx);
      else await tx();
    };
    const order = winMode ? [winMode, ...allModes.filter((m) => m.label !== winMode!.label)] : allModes;
    const falhas: string[] = [];
    for (const m of order) {
      try {
        await runMode(m);
        winMode = m;
        return;
      } catch (err) {
        falhas.push(`${m.label}: ${err instanceof Error ? err.message : String(err)}`);
        if (isStale(err)) {
          try {
            await reResolveSlices();
          } catch {
            /* segue com o handle atual */
          }
        }
      }
    }
    throw new Error(`[${label}] nenhuma combinação de in/out passou · fps=${opts.fps} · ${falhas.join(" || ")}`);
  };

  await robustSetInOut((tick, sep) => {
    const c = first.video.clip;
    const IN = tick === "frame" && fr0 ? frTT(first.video.startSec) : tt(first.video.startSec);
    const OUT = tick === "frame" && fr0 ? frTT(first.video.endSec) : tt(first.video.endSec);
    return sep ? [c.createSetInPointAction(IN), c.createSetOutPointAction(OUT)] : [c.createSetInOutPointsAction(IN, OUT)];
  }, "setInOut vídeo fatia0");
  const seq = await step("createSequenceFromMedia", () =>
    project.createSequenceFromMedia(nome, [first.video.clip]),
  );
  const seqName = await step("ler seq.name", () => seq.name);
  const editor = await step("getEditor", () => ppro.SequenceEditor.getEditor(seq));

  // Criar a sequência reestruturou o projeto → os objetos de clipe expiraram. Re-resolve DE NOVO
  // (mesma instância) antes das Fases 2/3, que fazem setInOut/overwrite nos mesmos clipes.
  try {
    await reResolveSlices();
  } catch (e) {
    console.log("AC> re-resolve pós-sequência falhou:", e);
  }

  // TRAVA DE FRAME: tudo em FRAME (createWithFrameAndFrameRate), nunca em segundos —
  // assim vídeo e áudio caem no MESMO frame (sem o erro de seg->tick que deixava o áudio
  // ~1 frame mais longo). A OUT de cada fatia = IN + durF (mesmo durF do vídeo pros dois).
  const fr = await step("getVideoFrameRate", async () => (await seq.getSettings()).getVideoFrameRate());
  const fps = fr.value;
  const frameN = (n: number) => ppro.TickTime.createWithFrameAndFrameRate(n, fr);

  // POSIÇÃO BACK-TO-BACK (anti-gap): cada fatia começa EXATAMENTE no frame onde a anterior
  // terminou — acumulamos a duração em FRAMES (durFs) em vez de recalcular `round(outStartSec*fps)`
  // por fatia. Aquele cálculo independente deixava 1 frame de gap quando o fps de cálculo
  // (timebase da sequência original) ≠ fps da sequência de saída (footage 29.97/59.94 em seq 30/60).
  // Assim o rough cut sai colado, sem sobra de ondulação, qualquer que seja o frame rate.
  const durFs = slices.map((s) => Math.round((s.video.endSec - s.video.startSec) * fps));
  const ats: number[] = [];
  {
    let acc = 0;
    for (let i = 0; i < slices.length; i++) {
      ats.push(acc);
      acc += durFs[i];
    }
  }

  // ----- Fase 2: deposita TODAS as fatias de vídeo (inclui a 0, refazendo frame-exact). -----
  // CRÍTICO: set in/out e overwrite em transações SEPARADAS (na mesma, o overwrite lê o in/out
  // ANTIGO — a fatia saía com a origem da anterior + fragmentos).
  for (let i = 0; i < slices.length; i++) {
    const v = slices[i].video;
    const at = ats[i];
    const inF = Math.round(v.startSec * fps);
    const durF = durFs[i];
    await robustSetInOut((tick, sep) => {
      const c = v.clip;
      const IN = tick === "frame" ? frameN(inF) : tt(v.startSec);
      const OUT = tick === "frame" ? frameN(inF + durF) : tt(v.endSec);
      return sep ? [c.createSetInPointAction(IN), c.createSetOutPointAction(OUT)] : [c.createSetInOutPointsAction(IN, OUT)];
    }, `in/out vídeo #${i}`);
    await stepRetry(`vídeo #${i} @f${at}`, () =>
      project.lockedAccess(() => {
        project.executeTransaction((ca) => {
          ca.addAction(editor.createOverwriteItemAction(v.projectItem, frameN(at), 0, 0));
        }, "AutoCut: depositar vídeo");
      }),
    );
  }

  // ----- Fase 3: áudio real no A1, MESMA posição (frame) e MESMA duração de frames do vídeo. -----
  if (!opts.videoOnly) {
    for (let i = 0; i < slices.length; i++) {
      const aud = slices[i].audio;
      const at = ats[i]; // MESMA posição back-to-back do vídeo
      const inF = Math.round(aud.startSec * fps);
      const durF = durFs[i]; // duração do VÍDEO = referência (áudio casa no mesmo frame)
      await robustSetInOut((tick, sep) => {
        const c = aud.clip;
        const IN = tick === "frame" ? frameN(inF) : tt(aud.startSec);
        const OUT = tick === "frame" ? frameN(inF + durF) : tt(aud.endSec);
        return sep ? [c.createSetInPointAction(IN), c.createSetOutPointAction(OUT)] : [c.createSetInOutPointsAction(IN, OUT)];
      }, `in/out áudio #${i}`);
      await stepRetry(`áudio #${i} @f${at}`, () =>
        project.lockedAccess(() => {
          project.executeTransaction((ca) => {
            // overwrite (sem ripple) no A1 (índice 0), mesma posição e duração do vídeo.
            ca.addAction(editor.createOverwriteItemAction(aud.projectItem, frameN(at), 0, 0));
          }, "AutoCut: sobrescrever áudio");
        }),
      );
    }
  }

  // DIAGNÓSTICO: lê de volta o que de fato ficou no V1 e no A1 da sequência montada.
  if (opts.onDebug) {
    try {
      const v1 = await seq.getVideoTrack(0);
      const a1 = await seq.getAudioTrack(0);
      const videoRows = await readBackTrack(v1 as never);
      const audioRows = await readBackTrack(a1 as never);
      await opts.onDebug("built-sequence", {
        seqName,
        fatiasPlanejadas: slices.length,
        v1: { n: videoRows.length, items: videoRows },
        a1: { n: audioRows.length, items: audioRows },
      });
    } catch (e) {
      await opts.onDebug("built-sequence-erro", { msg: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log("AC> rough cut montado:", seqName);
  return seqName;
}
