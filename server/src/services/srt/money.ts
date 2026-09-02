// DINHEIRO EM NUMERAL (só no estilo CINEMA).
//
// O postprocess compartilhado (`postprocess-transcript.mjs`, do skill vsl-editor) converte todo
// montante com cifrão pra forma FALADA: "R$ 40.000" → "40 mil reais". Isso é o certo pra legenda
// dinâmica de reels, que acompanha a fala palavra por palavra. Na legenda de cinema o Sávio
// pediu o NUMERAL (28/ago), que é a convenção de legendagem.
//
// O script compartilhado não tem flag pra desligar isso, e ele NÃO pode ser alterado (roda em
// produção no plugin Legendas RECONECTA e no skill vsl-editor). A saída daqui é fundir cada
// montante num ÚNICO token já formatado ("R$ 40.000") ANTES de chamar o postprocess: com o
// espaço depois da cifra, o token deixa de casar com o regex `^r?\$(\d[\d.,]*)?$` do
// normalizarDinheiro e atravessa o script intacto. As correções de nome continuam rodando.
//
// A detecção aqui é um espelho da do script compartilhado — de propósito: interceptamos
// exatamente os mesmos montantes que ele converteria, nem mais nem menos.
import type { Word } from "../../../../shared/types";

/** Tira a pontuação final do token (mesma regra do postprocess compartilhado). */
function strip(w: string): string {
  return w.replace(/[.,;:!?]+$/g, "");
}

/** Devolve a pontuação final do token ("R$ 40.000." precisa manter o ponto: é fim de frase). */
function suffix(w: string): string {
  const m = w.match(/[.,;:!?]+$/);
  return m ? m[0] : "";
}

/** Pedaço numérico solto que o WhisperX cospe depois da cifra: "20", ".000", ",00". */
function ehParteNumerica(w: string): boolean {
  return /^[.,]?\d[\d.,]*$/.test(strip(w));
}

/** 40000 → "40.000" (separador de milhar brasileiro, sem depender de ICU/toLocaleString). */
function milhar(v: number): string {
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Funde cada montante em R$ num único token já no formato "R$ 40.000".
 * Devolve as palavras novas + quantos montantes foram fundidos.
 *
 * O token fundido herda o start da cifra e o end do último dígito — o span de tempo é o mesmo
 * do montante falado, então nada desalinha na legenda.
 */
export function mergeMoneyToNumeral(words: Word[]): { words: Word[]; n: number } {
  const out: Word[] = [];
  let i = 0;
  let n = 0;

  while (i < words.length) {
    const w0 = strip(words[i].word);
    let numStr = "";
    let j: number; // índice logo depois da cifra

    // A cifra vem colada num dígito ("$1", "R$1.500") ou separada ("R" + "$", "R$", "$").
    const m0 = w0.match(/^r?\$(\d[\d.,]*)?$/i);
    if (m0) {
      numStr = m0[1] ?? "";
      j = i + 1;
    } else if (/^r$/i.test(w0) && i + 1 < words.length) {
      const m1 = strip(words[i + 1].word).match(/^\$(\d[\d.,]*)?$/);
      if (!m1) {
        out.push(words[i]);
        i++;
        continue;
      }
      numStr = m1[1] ?? "";
      j = i + 2;
    } else {
      out.push(words[i]);
      i++;
      continue;
    }

    // Consome os pedaços numéricos que vierem em seguida.
    let k = j;
    while (k < words.length && ehParteNumerica(words[k].word)) {
      numStr += strip(words[k].word);
      k++;
    }

    // Cifrão sem número ("custa uns R$ aí") → deixa como estava.
    if (!/\d/.test(numStr)) {
      out.push(words[i]);
      i++;
      continue;
    }
    const valor = parseInt(numStr.split(",")[0].replace(/\./g, ""), 10); // centavos ignorados
    if (!Number.isFinite(valor) || valor <= 0) {
      out.push(words[i]);
      i++;
      continue;
    }

    out.push({
      word: `R$ ${milhar(valor)}${suffix(words[k - 1].word)}`,
      start: words[i].start,
      end: words[k - 1].end,
    });
    n++;
    i = k;
  }

  return { words: out, n };
}
