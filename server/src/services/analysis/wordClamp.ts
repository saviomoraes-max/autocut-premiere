// Trava de segurança: recorta os cortes de SILÊNCIO para nunca comer a parte AUDÍVEL
// de uma palavra — mas SEM deixar de cortar pausa de verdade.
//
// Princípio: o detector de silêncio é a fonte da verdade sobre "tem som audível?".
// A transcrição (WhisperX) às vezes coloca palavras-fantasma DENTRO de uma pausa
// silenciosa, ou o force-align infla o `word.end` pra dentro da pausa. Se a trava
// protegesse o span cru da palavra, essas pausas nunca seriam cortadas.
//
// Então a trava protege apenas a parte AUDÍVEL de cada palavra = (span da palavra)
// MENOS (as regiões de silêncio). Consequências:
//   - palavra inteiramente dentro do silêncio (fantasma) -> parte audível vazia ->
//     não protege nada -> a pausa é cortada.
//   - palavra na borda (cauda/onset inflado pra dentro do silêncio) -> só a beirada
//     audível (fora do silêncio) é protegida, com a guarda; a parte inflada é cortada.
//   - palavra normal no meio da fala -> protegida inteira (não toca nenhum corte).
//
// Só se aplica a cortes de silêncio. Cortes semânticos (bad-take) removem fala de
// propósito e não passam por aqui.
import type { Cut, Word } from "../../../../shared/types";

export interface WordClampOptions {
  /** Margem audível mantida em volta da parte falada de cada palavra (s). */
  guardSec?: number;
  /** Pedaço de corte menor que isto (s) é descartado. */
  minCutSec?: number;
}

type Span = [number, number];

/** Remove o intervalo [rs,re] de uma lista de pedaços, devolvendo o que sobra. */
function subtract(pieces: Span[], rs: number, re: number): Span[] {
  const out: Span[] = [];
  for (const [s, e] of pieces) {
    if (re <= s || rs >= e) {
      out.push([s, e]); // sem sobreposição
    } else {
      if (rs > s) out.push([s, rs]); // sobra antes
      if (re < e) out.push([re, e]); // sobra depois
    }
  }
  return out;
}

export function clampCutsToWordGaps(
  cuts: Cut[],
  words: Word[],
  opts: WordClampOptions = {},
): Cut[] {
  const guard = Math.max(0, opts.guardSec ?? 0.05);
  const minCut = Math.max(0, opts.minCutSec ?? 0.12);

  // Regiões de silêncio (os próprios cortes) — usadas pra descontar das palavras.
  const sil: Span[] = cuts
    .map((c) => [c.start, c.end] as Span)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  // Spans protegidos = parte AUDÍVEL de cada palavra (palavra menos silêncio) + guarda.
  const prot: Span[] = [];
  for (const w of words) {
    if (!(Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)) continue;
    let audible: Span[] = [[w.start, w.end]];
    for (const [ss, se] of sil) {
      if (se <= w.start) continue;
      if (ss >= w.end) break; // sil ordenado: o resto está além da palavra
      audible = subtract(audible, ss, se);
      if (!audible.length) break;
    }
    for (const [as_, ae] of audible) prot.push([as_ - guard, ae + guard]);
  }
  prot.sort((a, b) => a[0] - b[0]);

  // Corta cada silêncio removendo as partes protegidas (audíveis).
  const out: Cut[] = [];
  for (const cut of cuts) {
    let pieces: Span[] = [[cut.start, cut.end]];
    for (const [ps, pe] of prot) {
      if (pe <= cut.start) continue;
      if (ps >= cut.end) break;
      pieces = subtract(pieces, ps, pe);
      if (!pieces.length) break;
    }
    for (const [s, e] of pieces) {
      // blindagem garbage-in: nunca emite borda não-finita/degenerada.
      if (Number.isFinite(s) && Number.isFinite(e) && e - s >= minCut) out.push({ ...cut, start: s, end: e });
    }
  }
  return out;
}
