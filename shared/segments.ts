// Lógica pura (sem dependências) do modo "achatar a timeline".
//
// O Auto-Edit roda em VÁRIOS clipes (seleção) ou na sequência inteira. O áudio de
// cada clipe é CONCATENADO num único stream contínuo (o "stream achatado") e
// transcrito/analisado uma vez só — assim o Claude vê a narrativa inteira e pega
// repetição/bad-take que cruza a fronteira entre clipes.
//
// Cada segmento é um PAR linkado na timeline: um clipe de VÍDEO (V1) + um clipe de
// ÁUDIO (A1), ocupando o mesmo span de timeline. O áudio do A1 é o que se transcreve
// (pode ser um arquivo separado do vídeo). O rough cut final leva o vídeo no V1 e o
// áudio real no A1, em sincronia.
//
// Domínios de tempo:
//   1. ACHATADO → segundos no stream concatenado (0 = início do 1º clipe). É o domínio
//      da transcrição, do silêncio e dos cortes que voltam do backend.
//   2. RELATIVO AO SEGMENTO → segundos desde o início do segmento. Como vídeo e áudio
//      andam 1:1 (linkados/sincronizados), o MESMO offset relativo serve pros dois:
//      origem do vídeo = vIn + rel,  origem do áudio = aIn + rel.
//
// Este módulo faz ACHATADO → RELATIVO: dado o layout (durações) e os trechos a MANTER
// (em tempo achatado), devolve, por fatia, o índice do segmento + o offset relativo
// (snapado a frame). Quem chama soma vIn/aIn pra chegar na mídia de origem de cada trilha.
import type { KeepSegment } from "./types";

/** Duração deste segmento no stream achatado (s) = duração do áudio transcrito. */
export interface SegmentInput {
  flatDurSec: number;
}

/** Um segmento já posicionado no stream achatado. */
export interface LaidSegment {
  /** Índice na ordem de timeline (casa com a lista enviada ao backend). */
  index: number;
  /** Início deste segmento no stream achatado (s). */
  flatStart: number;
  /** Fim deste segmento no stream achatado (s). */
  flatEnd: number;
}

export interface FlatLayout {
  laid: LaidSegment[];
  /** Duração total do stream achatado (s) = soma das durações dos segmentos. */
  totalSec: number;
}

/** Posiciona os segmentos no stream achatado, em sequência (sem gaps). */
export function layoutSegments(segments: ReadonlyArray<SegmentInput>): FlatLayout {
  const laid: LaidSegment[] = [];
  let cursor = 0;
  segments.forEach((s, index) => {
    const dur = Math.max(0, s.flatDurSec);
    laid.push({ index, flatStart: cursor, flatEnd: cursor + dur });
    cursor += dur;
  });
  return { laid, totalSec: cursor };
}

/** Posição de um segmento: duração no achatado + onde ele começa na TIMELINE real. */
export interface TimelinePlacement {
  flatDurSec: number;
  timelineStartSec: number;
}

/**
 * Remapeia tempos do domínio ACHATADO (transcrição: clips colados em 0..N) para o domínio da
 * TIMELINE real. Cada segmento i ocupa [flatStart_i, flatEnd_i] no achatado e começa em
 * timelineStartSec_i na timeline; um tempo achatado `t` do segmento i vira
 * `timelineStartSec_i + (t - flatStart_i)`.
 *
 * Resolve o "buraco"/desalinhamento do SRT em multi-clip: antes um OFFSET ÚNICO
 * (timelineStartSec do 1º clip) era somado a tudo, assumindo que os clips fossem contíguos.
 * Quando há gaps/cortes entre clips, as legendas dos clips seguintes caíam no lugar errado e
 * sobravam trechos sem legenda. Com 1 clip (ou clips contíguos) o resultado é idêntico ao
 * antigo — sem regressão.
 */
export function remapFlatTimesToTimeline<T extends { start: number; end: number }>(
  items: ReadonlyArray<T>,
  placements: ReadonlyArray<TimelinePlacement>,
): T[] {
  const { laid } = layoutSegments(placements);
  if (!laid.length) return items.map((it) => ({ ...it }));
  const offsetForFlat = (t: number): number => {
    let i = laid.findIndex((l) => t >= l.flatStart && t < l.flatEnd);
    if (i < 0) i = t < laid[0].flatStart ? 0 : laid.length - 1; // clamp nas bordas
    return placements[i].timelineStartSec - laid[i].flatStart;
  };
  // Mesmo offset pro start e pro end (uma palavra vive num clip só) — preserva a duração.
  return items.map((it) => {
    const off = offsetForFlat(it.start);
    return { ...it, start: it.start + off, end: it.end + off };
  });
}

/** Uma fatia a manter, identificada pelo segmento dono + offset relativo a ele. */
export interface SourceSlice {
  /** Qual segmento (índice) é o dono — quem chama acha o par vídeo/áudio. */
  segmentIndex: number;
  /** Início da fatia, relativo ao começo do segmento (s), snapado a frame. */
  relStartSec: number;
  /** Fim da fatia, relativo ao começo do segmento (s), snapado a frame. */
  relEndSec: number;
}

export interface MapOptions {
  /** Frame rate da sequência — snapa as fronteiras das fatias em frame. */
  fps: number;
  /** Fatia menor que isto (s) é descartada (fragmento inútil na fronteira). */
  minSliceSec?: number;
}

/**
 * Mapeia os trechos a MANTER (em tempo ACHATADO) para fatias, CORTANDO em cada
 * fronteira de segmento — um keep que cruza dois clipes vira duas fatias contíguas
 * (clipes diferentes => clips separados no rough cut). As fatias saem em ordem de
 * reprodução. O offset é RELATIVO ao segmento; quem chama soma vIn/aIn por trilha.
 */
export function mapKeepsToSourceSlices(
  keeps: ReadonlyArray<KeepSegment>,
  laid: ReadonlyArray<LaidSegment>,
  opts: MapOptions,
): SourceSlice[] {
  const fps = opts.fps > 0 ? opts.fps : 25;
  const minSlice = Math.max(0, opts.minSliceSec ?? 0.04);
  const snap = (t: number) => Math.round(t * fps) / fps;

  const out: SourceSlice[] = [];
  // keeps vêm ordenados (ascendente) de computeKeeps; laid também. O duplo-loop
  // preserva a ordem de reprodução.
  for (const k of keeps) {
    for (const seg of laid) {
      const a = Math.max(k.start, seg.flatStart);
      const b = Math.min(k.end, seg.flatEnd);
      if (b - a <= 0) continue; // sem sobreposição com este segmento
      const relStartSec = snap(a - seg.flatStart);
      const relEndSec = snap(b - seg.flatStart);
      if (relEndSec - relStartSec >= minSlice) {
        out.push({ segmentIndex: seg.index, relStartSec, relEndSec });
      }
    }
  }
  return out;
}

/** Impacto de um corte sobre os clipes: quanto ele apaga do clipe mais afetado. */
export interface CutClipImpact {
  /** Maior fração (0..1) de UM único segmento que este corte remove. */
  maxCoverage: number;
  /** Índice do segmento mais afetado (-1 se nenhum). */
  segmentIndex: number;
  /** Segundos removidos do segmento mais afetado. */
  removedSec: number;
}

/**
 * Para cada corte (em tempo ACHATADO), mede quanto ele apaga do clipe mais
 * afetado. É a base da TRAVA DE SEGURANÇA: um corte que remove quase um clipe
 * inteiro (um take/bloco) é perigoso e não deve sumir sem o editor decidir.
 */
export function assessCutsClipImpact(
  cuts: ReadonlyArray<{ start: number; end: number }>,
  laid: ReadonlyArray<LaidSegment>,
): CutClipImpact[] {
  return cuts.map((c) => {
    let maxCoverage = 0;
    let segmentIndex = -1;
    let removedSec = 0;
    for (const seg of laid) {
      const span = seg.flatEnd - seg.flatStart;
      if (span <= 0) continue;
      const ov = Math.max(0, Math.min(c.end, seg.flatEnd) - Math.max(c.start, seg.flatStart));
      if (ov <= 0) continue;
      const cov = ov / span;
      if (cov > maxCoverage) {
        maxCoverage = cov;
        segmentIndex = seg.index;
        removedSec = ov;
      }
    }
    return { maxCoverage, segmentIndex, removedSec };
  });
}

/**
 * Um corte é "perigoso" (apaga ~um clipe inteiro) quando cobre a maior parte de
 * um clipe SUBSTANCIAL. Limiares conservadores: ≥80% de um clipe de ≥8s — pega
 * take/bloco inteiro (ex.: clipes de 5min cortados como "repetição") sem alarmar
 * por micro-clipes ou silêncios curtos.
 */
export function isDangerousCut(impact: CutClipImpact): boolean {
  return impact.maxCoverage >= 0.8 && impact.removedSec >= 8;
}
