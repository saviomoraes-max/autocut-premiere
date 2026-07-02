// Lógica pura (sem dependências) de transformação de CORTES -> KEEP-SEGMENTS.
// É o coração do "aplicar cortes": como não existe razor programático no Premiere,
// montamos uma sequência nova só com os trechos MANTIDOS (o complemento dos cortes).
import type { CutReason, KeepSegment } from "./types";

export interface ComputeKeepsOptions {
  /** Frame rate da sequência — usado pra snapar as fronteiras em frame. */
  fps: number;
  /**
   * Offset (s) somado a cada keep pra mapear do tempo da TRANSCRIÇÃO (0 = início do
   * trecho transcrito) para o tempo da MÍDIA DE ORIGEM. É o in point do clip.
   */
  sourceOffsetSec?: number;
  /** Margem (s) mantida em volta de cada corte, pra não cortar rente à fala. */
  paddingSec?: number;
  /** Keep menor que isto (s) é descartado (sliver inútil entre dois cortes). */
  minKeepSec?: number;
}

/**
 * Recebe os cortes aprovados (em segundos relativos ao áudio transcrito) e devolve
 * os trechos a MANTER, já em tempo da mídia de origem e snapados a frame.
 */
export function computeKeeps(
  cuts: ReadonlyArray<{ start: number; end: number; reason?: CutReason }>,
  totalDurationSec: number,
  opts: ComputeKeepsOptions,
): KeepSegment[] {
  const fps = opts.fps > 0 ? opts.fps : 25;
  const offset = opts.sourceOffsetSec ?? 0;
  // Margem mantida em volta de cada corte (s). Com a trava por palavra no backend,
  // a segurança das palavras TRANSCRITAS é precisa. Esta margem (0.06) é o ÚNICO
  // backup pra fala NÃO-transcrita (mumble/"né"/"tá") que a trava não enxerga.
  // 0.05(guard) + 0.06 = ~0.11s em volta de palavra real; ainda mais agressivo que
  // a baseline antiga (0.08 sem trava). NÃO zerar os dois lados ao mesmo tempo.
  const pad = Math.max(0, opts.paddingSec ?? 0.06);
  const minKeep = Math.max(0, opts.minKeepSec ?? 0.12);
  const snap = (t: number) => Math.round(t * fps) / fps;

  // 1. Encolhe cada corte por `pad` (mantém margem em volta), clampa e ordena.
  //    EXCEÇÃO: corte de retake (bad_take) é remoção INTENCIONAL de um take inteiro, com
  //    fronteiras já exatas (início do bloco + fim da frase-sinal). Pad nele deixaria um
  //    sliver de ~2 frames do TAKE RUIM no começo da sequência do bloco → sem pad.
  const cortes = cuts
    .map((c) => {
      // bad_take e comando são remoção INTENCIONAL e total (take ruim / recado pro editor), com
      // fronteiras já exatas — pad deixaria um sliver do trecho ruim. Os demais mantêm a margem.
      const p = c.reason === "bad_take" || c.reason === "comando" ? 0 : pad;
      return { start: Math.max(0, c.start + p), end: Math.min(totalDurationSec, c.end - p) };
    })
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);

  // 2. Funde cortes sobrepostos (defensivo, mesmo já vindo de mergeCuts).
  const fundidos: Array<{ start: number; end: number }> = [];
  for (const c of cortes) {
    const u = fundidos[fundidos.length - 1];
    if (u && c.start <= u.end) u.end = Math.max(u.end, c.end);
    else fundidos.push({ ...c });
  }

  // 3. Complemento = trechos mantidos dentro de [0, totalDuration].
  const keeps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of fundidos) {
    if (c.start > cursor) keeps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < totalDurationSec) keeps.push({ start: cursor, end: totalDurationSec });

  // 4. Mapeia p/ a mídia de origem (+offset), snapa a frame, descarta slivers.
  return keeps
    .map((k) => ({ start: snap(offset + k.start), end: snap(offset + k.end) }))
    .filter((k) => k.end - k.start >= minKeep);
}

/** Soma a duração total mantida (s). Útil pra mostrar "vídeo final: Xs". */
export function totalKeptSeconds(keeps: ReadonlyArray<KeepSegment>): number {
  return keeps.reduce((acc, k) => acc + (k.end - k.start), 0);
}
