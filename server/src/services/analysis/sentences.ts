// Utilidades de texto puras, compartilhadas pelos detectores que trabalham por SENTENÇA
// (comando/recado pro editor e take-repetido). Determinístico, sem LLM.
import type { Word } from "../../../../shared/types";

/** Normaliza uma palavra pra comparação: minúscula, sem pontuação/acento-de-borda. */
export function norm(w: string): string {
  return w
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // tira acentos (casa "aeroporto"/"aeroporto")
    .replace(/[^a-z0-9]/g, "");
}

/** Uma sentença falada, com seu span de tempo (ACHATADO) e as palavras que a compõem. */
export interface Sentence {
  /** Índice da 1ª palavra na transcrição. */
  wordStart: number;
  /** Índice da última palavra (inclusive). */
  wordEnd: number;
  startSec: number;
  endSec: number;
  /** Tokens normalizados (só os não-vazios) — base dos shingles. */
  toks: string[];
  /** Texto legível pra revisão humana. */
  text: string;
}

/**
 * Quebra a transcrição em sentenças na pontuação forte (.!?), exigindo um mínimo de palavras
 * pra fechar (evita "." solto virar sentença). Mantém os spans de tempo pra virar corte/marcador.
 */
export function splitSentences(words: Word[], minWords = 3): Sentence[] {
  const out: Sentence[] = [];
  let start = -1;
  const toks: string[] = [];
  const raw: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (start < 0) start = i;
    const t = norm(words[i].word);
    if (t) toks.push(t);
    raw.push(words[i].word);
    const fechou = /[.!?]$/.test(words[i].word.trim());
    if (fechou && raw.length >= minWords) {
      out.push({
        wordStart: start,
        wordEnd: i,
        startSec: words[start].start,
        endSec: words[i].end,
        toks: [...toks],
        text: raw.join(" ").trim(),
      });
      start = -1;
      toks.length = 0;
      raw.length = 0;
    }
  }
  // Sobra final sem pontuação → vira uma sentença também.
  if (start >= 0 && raw.length) {
    out.push({
      wordStart: start,
      wordEnd: words.length - 1,
      startSec: words[start].start,
      endSec: words[words.length - 1].end,
      toks: [...toks],
      text: raw.join(" ").trim(),
    });
  }
  return out;
}

/** Shingles = conjunto de n-gramas de tokens (n=3 por padrão) — a "impressão digital" da frase. */
export function shingles(toks: string[], n = 3): Set<string> {
  if (toks.length < n) return new Set(toks.length ? [toks.join(" ")] : []);
  const s = new Set<string>();
  for (let i = 0; i <= toks.length - n; i++) s.add(toks.slice(i, i + n).join(" "));
  return s;
}

/** Similaridade de Jaccard entre dois conjuntos (0..1). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
