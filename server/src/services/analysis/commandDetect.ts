// FEATURE "remover recado pro editor": o Léo, gravando talking head, às vezes fala PRA O
// EDITOR ("vou gravar de novo", "peraí", "vamos lá", "vou falar de novo, tá?"). Essa fala é
// instrução, não conteúdo — nunca entra no corte final. Este detector a acha por CÓDIGO e
// devolve cortes (reason "comando", remoção total sem pad).
//
// Aterrado no bruto real (2026-07-01, VSL Juliana): "Vamos lá. Peraí." [0:24], "Gravar essa
// última parte de novo." [2:37], "Vamos de novo." [11:07], "Vou falar de novo, tá?" [11:53],
// "Vou gravar de novo o 6." [16:30].
//
// SEGURANÇA: só corta quando a frase de comando é uma SENTENÇA CURTA (≤ maxWords). Assim
// "Vamos lá. A Juliana se via no espelho…" corta só o "Vamos lá." (sentença própria) e o
// conteúdo emendado depois fica intacto.
import type { Cut, Word } from "../../../../shared/types";
import { splitSentences } from "./sentences";

// Frases inequívocas de recado pro editor. Casadas contra a sentença normalizada (minúscula).
const COMANDOS: RegExp[] = [
  /vou gravar de novo/,
  /vou falar de novo/,
  /vou ler de novo/,
  /vou (re)?fazer de novo/,
  /gravar (essa|a) (ultima|última) parte/,
  /gravar de novo o? ?\d*/,
  /vou recome[cç]ar/,
  /vamos de novo/,
  /\bvamos l[aá]\b/,
  /deixa eu (refazer|repetir|come[cç]ar de novo|gravar de novo)/,
  /\bcorta (isso|essa|aqui|essa parte)\b/,
  /pode cortar/,
  /\bpera[ií]+\b/,
  /\bespera a[ií]\b/,
];

export interface CommandDetectOptions {
  /** Só corta se a sentença tiver ATÉ isto de palavras (frase de comando é curta). */
  maxWords?: number;
}

/** Acha as sentenças que são recado pro editor e devolve os cortes correspondentes. */
export function detectCommandCuts(words: Word[], opts: CommandDetectOptions = {}): Cut[] {
  const maxWords = opts.maxWords ?? 8;
  const sents = splitSentences(words, 1); // aqui aceita sentença de 1+ palavra ("Peraí.")
  const out: Cut[] = [];
  for (const s of sents) {
    if (s.toks.length > maxWords) continue; // frase longa = provável conteúdo, não comando
    const low = s.text.toLowerCase();
    const hit = COMANDOS.find((rx) => rx.test(low));
    if (!hit) continue;
    out.push({
      start: s.startSec,
      end: s.endSec,
      reason: "comando",
      detail: `recado pro editor: "${s.text.slice(0, 60)}"`,
    });
  }
  return out;
}
