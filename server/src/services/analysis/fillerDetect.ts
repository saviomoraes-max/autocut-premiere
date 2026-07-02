// Detector de FILLER por CÓDIGO (sem LLM) — determinístico e EXATO: o timestamp vem
// direto da palavra do WhisperX, sem o modelo "copiar número" (foi onde o 7B errava).
// Conservador ("na dúvida, NÃO corta", igual ao SYSTEM_PROMPT). Cobre só os casos
// inequívocos — sons de hesitação alongados + gagueira; deixa os ambíguos ("é", "né",
// "então", "tipo", que dependem de contexto) pro humano. Calibrar contra o gabarito.
import type { Cut, Word } from "../../../../shared/types";

// Fillers NÃO-lexicais (sons de hesitação). Evita de propósito palavras reais:
// "é" (verbo), "um" (artigo/número), "ah" (interjeição) NÃO entram sozinhos.
const FILLER_RE: RegExp[] = [
  /^é{2,}$/i, // éé, ééé (alongado — "é" sozinho é o verbo, fica de fora)
  /^a*h+n+$/i, // ahn, aahn, hn (hesitação com 'n')
  /^h+u?m+$/i, // hum, hmm, hummm
  /^ã+h?n?$/i, // ã, ãã, ãhn
];

function norm(word: string): string {
  return word
    .trim()
    .toLowerCase()
    .replace(/[.,!?…":;]/g, "");
}

function isFiller(word: string): boolean {
  const w = norm(word);
  return w.length > 0 && FILLER_RE.some((re) => re.test(w));
}

export interface FillerOptions {
  /** Gap máx (s) entre palavras repetidas pra contar como gagueira. */
  stutterMaxGapSec?: number;
  /** Só trata repetição como gagueira pra palavras curtas (≤ isto chars) — evita
   *  cortar ênfase legítima tipo "muito muito". */
  stutterMaxLen?: number;
}

/**
 * Acha cortes de filler/gagueira na transcrição palavra a palavra. Cada corte usa o
 * start/end EXATO das próprias palavras (sem aproximação). Reason = "filler".
 */
export function detectFillerCuts(words: Word[], opts: FillerOptions = {}): Cut[] {
  const stutterGap = opts.stutterMaxGapSec ?? 0.5;
  const stutterMaxLen = opts.stutterMaxLen ?? 3;
  const cuts: Cut[] = [];

  // 1) Hesitação isolada (éé, ahn, hum, ã...).
  for (const w of words) {
    if (isFiller(w.word)) {
      cuts.push({ start: w.start, end: w.end, reason: "filler", detail: `muleta '${w.word.trim()}'` });
    }
  }

  // 2) Gagueira: palavra CURTA repetida em sequência → corta as anteriores, mantém a última.
  //    ex.: "o o o resultado" → corta os dois primeiros "o".
  let i = 0;
  while (i < words.length) {
    const base = norm(words[i].word);
    if (base.length === 0 || base.length > stutterMaxLen) {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < words.length &&
      norm(words[j + 1].word) === base &&
      words[j + 1].start - words[j].end <= stutterGap
    ) {
      j++;
    }
    if (j > i) {
      // Repetições i..j da mesma palavra: corta de i até o início da última (mantém a última).
      cuts.push({
        start: words[i].start,
        end: words[j].start,
        reason: "filler",
        detail: `gagueira '${words[i].word.trim()}', mantida uma`,
      });
      i = j + 1;
    } else {
      i++;
    }
  }

  return cuts;
}
