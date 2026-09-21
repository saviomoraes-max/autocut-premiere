// FALSO COMEÇO por código (sem LLM) — v2 do AutoCut, 21/set/2026.
//
// O Scribe v2 em modo verbatim marca a palavra onde a fala foi interrompida com traço no fim
// ("quanto que tu-- quanto que custa"). O WhisperX não tem essa marca (ele alisa a fala), então
// este detector só acha algo em transcrição do ElevenLabs — com o WhisperX ele não faz nada.
//
// Vem do Bisturi, adaptado: lá quem decide o corte é o Claude lendo o verbatim, e a varredura
// mecânica só procura "--" que sobrou (scripts/decupagem_varrer_resultado.py). Aqui a decisão é
// determinística e CONSERVADORA ("na dúvida, mantém", igual ao perfil de anúncio do Bisturi):
// só corta quando a pessoa RECOMEÇA a mesma frase depois do traço — a retomada repete o começo
// da tentativa abortada. É o mesmo sinal que, medido em 28/08 nas transcrições reais, recuperava
// 89% dos retakes que o detector de take repetido deixava passar (casamento de início).
//
//   "que ela segurava-- que a paciente…"   → corta "que ela segurava--", fica "que a paciente…"
//   "olha se esse não é o-- olha se essa…"  → corta "olha se esse não é o--"
//   "se o buraco fosse-- e depois…"         → NÃO corta: mudou de direção, sem retomada
//
// O corte é "bad_take": fronteira exata, sem margem, do início da 1ª palavra abortada ao fim da
// palavra com traço — exatamente o que acontece quando o editor apaga essas palavras no
// "Editar por texto". Margem aqui deixaria o começo da palavra abortada audível ("q-").
import type { Cut, Word } from "../../../../shared/types";

/** Palavra que termina com o traço de fala cortada (antes de pontuação final, se houver). */
const COM_TRACO = /-+[.,;:!?…]*$/u;

// Palavras de ligação: casar SÓ uma delas é fraco demais ("que" aparece em toda frase). Com uma
// palavra só de casamento, ela precisa ser conteúdo — ou a tentativa precisa começar numa
// fronteira de frase/pausa.
const LIGACAO = new Set([
  "a", "o", "as", "os", "e", "é", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
  "que", "se", "um", "uma", "eu", "ele", "ela", "pra", "pro", "por", "com", "mas", "ou", "aí",
  "né", "tipo", "então", "isso", "esse", "essa", "tu", "você",
]);

// Compara palavras COM acento: sem ele, "é" (verbo) casava com "e" (conjunção) e o detector
// cortava só "é ex--" em "E aqui é ex-- e aqui é exatamente", deixando "E aqui" duplicado (21/09).
function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export interface FalsoComecoOptions {
  /** Pausa máxima (s) entre a palavra com traço e a retomada. Mais que isso é outra fala.
   *  3 s porque o dado real pediu: "olha se esse não é o-- [2,34 s] olha se essa" (Bisturi, 08/07). */
  maxGapRetomadaSec?: number;
  /** Quantas palavras, no máximo, a tentativa abortada pode ter. */
  maxPalavras?: number;
  /** Duração máxima (s) da tentativa abortada. */
  maxSpanSec?: number;
  /** Pausa (s) antes da tentativa que conta como fronteira (reforça casamento de 1 palavra). */
  pausaFronteiraSec?: number;
}

export function detectFalseStartCuts(words: Word[], opts: FalsoComecoOptions = {}): Cut[] {
  const maxGap = opts.maxGapRetomadaSec ?? 3;
  const maxPal = opts.maxPalavras ?? 12;
  const maxSpan = opts.maxSpanSec ?? 6;
  const pausaFronteira = opts.pausaFronteiraSec ?? 0.2;
  const n = words.length;
  const chave = words.map((w) => norm(w.word));
  const cortes: Cut[] = [];

  for (let d = 0; d < n - 1; d++) {
    if (!COM_TRACO.test(words[d].word)) continue;
    const r = d + 1; // 1ª palavra da retomada
    if (words[r].start - words[d].end > maxGap) continue;

    // Volta da palavra com traço procurando onde a tentativa começou: a posição s cujas palavras
    // repetem o começo da retomada. Ganha o casamento MAIS LONGO (é a frase recomeçada inteira);
    // empate fica com o mais próximo, que corta menos. Antes ganhava o mais próximo e um "é"
    // solto vencia "e aqui é" — cortava o pedaço errado.
    let melhor: { s: number; m: number } | null = null;
    for (let s = d; s >= Math.max(0, d - maxPal + 1); s--) {
      if (words[d].end - words[s].start > maxSpan) break;
      // Frase que TERMINOU (ponto, interrogação) antes do traço foi dita até o fim — não é parte
      // da tentativa abortada. Sem isto, "Quanto que custa a consulta? Quanto que tu-- quanto que
      // custa o Botox?" cortava a pergunta inteira da consulta, que é conteúdo (visto em 21/09).
      if (s < d && /[.!?…]$/u.test(words[s].word)) break;
      let m = 0;
      while (s + m <= d && r + m < n && chave[s + m] && chave[s + m] === chave[r + m]) m++;
      if (m === 0) continue;

      const fronteira =
        s === 0 ||
        /[.,;:!?…]$/u.test(words[s - 1].word) ||
        words[s].start - words[s - 1].end >= pausaFronteira;
      const forte = m >= 2 || !LIGACAO.has(chave[s]) || fronteira;
      if (forte && (!melhor || m > melhor.m)) melhor = { s, m };
    }
    if (!melhor) continue;

    const abortado = words.slice(melhor.s, d + 1).map((w) => w.word).join(" ");
    const retomada = words.slice(r, Math.min(n, r + 4)).map((w) => w.word).join(" ");
    cortes.push({
      start: words[melhor.s].start,
      end: words[d].end,
      reason: "bad_take",
      detail: `falso começo: "${abortado}" → retomou "${retomada}…"`,
    });
  }
  return cortes;
}
