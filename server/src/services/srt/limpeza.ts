// FALA CORTADA NA LEGENDA (21/set/2026).
//
// O Scribe v2 em modo verbatim marca palavra interrompida com traço no fim ("segurava--", "é--,").
// O AutoCut MANTÉM essa marca na transcrição — é informação pro corte e aparece no Editar por
// texto —, mas na legenda ela vazava: medido em 13 linhas de um bruto de 7 min (Bisturi, 08/07).
//
// Sai só o traço do FIM da palavra (antes de pontuação final, se houver). Hífen interno fica:
// "segunda-feira", "montanha-russa". Token que era só traço some.
// O WhisperX não produz esse traço (conferido nas 60 transcrições do cache em 21/09), então
// pra ele isto não muda nada.
import type { Word } from "../../../../shared/types";

export function limparFalaCortada(words: Word[]): { words: Word[]; n: number } {
  const out: Word[] = [];
  let n = 0;
  for (const w of words) {
    const limpo = w.word.replace(/-+(?=[.,;:!?…]*$)/u, "");
    if (limpo === w.word) {
      out.push(w);
      continue;
    }
    n++;
    if (!limpo.replace(/[.,;:!?…\s]/gu, "")) continue; // era só traço (e pontuação)
    out.push({ ...w, word: limpo });
  }
  return { words: out, n };
}
