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
    const temEscala = k < words.length && escalaDe(words[k].word) !== null;
    const [inteiro, decimal = ""] = numStr.split(",");
    const valor = parseInt(inteiro.replace(/\./g, ""), 10);
    if (!Number.isFinite(valor) || valor <= 0) {
      out.push(words[i]);
      i++;
      continue;
    }
    // Vírgula antes de ESCALA é decimal e fica ("R$ 1,5 milhão"). Sem escala são centavos,
    // ignorados como sempre ("R$ 9.300,00" → "R$ 9.300"). Corrigido em 21/09: antes a vírgula era
    // sempre descartada e "R$1,5 milhão" saía "R$ 1 milhão" — valor errado na legenda.
    const numero =
      temEscala && /^\d+$/.test(decimal) && Number(decimal) > 0 ? `${milhar(valor)},${decimal}` : milhar(valor);

    // "R$ 40 mil reais" / "R$ 200 reais": o "reais" repete a cifra → sai (o tempo dele fica com o
    // valor, pra não abrir buraco). Corrigido em 21/09: antes saía "R$ 40 mil reais".
    let fim = temEscala ? k : k - 1; // último token do montante
    if (fim + 1 < words.length && /^reais$/i.test(strip(words[fim + 1].word))) fim++;

    if (temEscala) {
      out.push({ word: `R$ ${numero}`, start: words[i].start, end: words[k - 1].end });
      out.push({ word: `${strip(words[k].word)}${suffix(words[fim].word)}`, start: words[k].start, end: words[fim].end });
    } else {
      out.push({ word: `R$ ${numero}${suffix(words[fim].word)}`, start: words[i].start, end: words[fim].end });
    }
    n++;
    i = fim + 1;
  }

  return { words: out, n };
}

// VALOR COM ESCALA NO REELS (21/set/2026).
//
// "R$ 62 mil" (WhisperX) e "R$250 mil" (o Scribe funde "250 mil reais" assim — registrado no
// Bisturi, sem parâmetro na API pra desligar) quebram no postprocess compartilhado: o
// normalizarDinheiro lê só o número colado na cifra e larga a escala pra trás, e o reels saía
// "62 reais mil". O defeito JÁ EXISTIA na v1 — visto numa transcrição real do WhisperX em 21/09.
//
// Aqui o montante com escala vira o INTEIRO equivalente num token só ("R$62.000") ANTES do
// postprocess, e a própria regra da casa (formatarReais) escreve o resto: "62 mil reais",
// "1 milhão e 500 mil reais", "2 milhões de reais". Nenhuma regra de dinheiro é duplicada aqui.
// Só no REELS: no cinema o "R$ 62 mil" já sai em algarismo, como o Sávio decidiu.
const ESCALA: Record<string, number> = {
  mil: 1e3,
  milhao: 1e6,
  milhoes: 1e6,
  bilhao: 1e9,
  bilhoes: 1e9,
};

function escalaDe(w: string): number | null {
  const base = strip(w).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return ESCALA[base] ?? null;
}

export function expandMoneyScale(words: Word[]): { words: Word[]; n: number } {
  const out: Word[] = [];
  let i = 0;
  let n = 0;

  while (i < words.length) {
    const w0 = strip(words[i].word);
    let numStr = "";
    let j: number; // índice logo depois da cifra (e do número, se vier colado)

    const m0 = w0.match(/^r?\$(\d[\d.,]*)?$/i); // "R$", "$", "R$250", "R$1,5"
    if (m0) {
      numStr = m0[1] ?? "";
      j = i + 1;
    } else if (/^r$/i.test(w0) && i + 1 < words.length && /^\$(\d[\d.,]*)?$/.test(strip(words[i + 1].word))) {
      numStr = strip(words[i + 1].word).slice(1);
      j = i + 2;
    } else {
      out.push(words[i]);
      i++;
      continue;
    }
    // Número separado da cifra: "R$" "62" "mil".
    if (!numStr && j < words.length && /^\d[\d.,]*$/.test(strip(words[j].word))) {
      numStr = strip(words[j].word);
      j++;
    }
    const escala = j < words.length ? escalaDe(words[j].word) : null;
    if (!numStr) {
      out.push(words[i]);
      i++;
      continue;
    }
    if (escala === null) {
      // Sem escala o postprocess já trata — exceto "R$ 200 reais", que ele escreveria "200 reais
      // reais". Não visto nas 60 transcrições do cache (21/09); tratado porque o cinema já trata
      // o mesmo caso e os dois estilos não podem divergir no mesmo texto.
      if (j < words.length && /^reais$/i.test(strip(words[j].word))) {
        out.push({ word: `R$${numStr}${suffix(words[j].word)}`, start: words[i].start, end: words[j].end });
        n++;
        i = j + 1;
        continue;
      }
      out.push(words[i]); // devolve só a cifra; o número e o resto passam intactos
      i++;
      continue;
    }

    // "1,5" é decimal; "1.500" é milhar.
    const base = numStr.includes(",")
      ? parseFloat(numStr.replace(/\./g, "").replace(",", "."))
      : parseInt(numStr.replace(/\./g, ""), 10);
    const valor = Math.round(base * escala);
    if (!Number.isFinite(valor) || valor <= 0) {
      out.push(words[i]);
      i++;
      continue;
    }

    let fim = j; // o token da escala
    // "R$ 62 mil reais": o "reais" já vai sair do formatarReais → absorve, senão "reais reais".
    if (fim + 1 < words.length && /^reais$/i.test(strip(words[fim + 1].word))) fim++;

    out.push({
      word: `R$${milhar(valor)}${suffix(words[fim].word)}`,
      start: words[i].start,
      end: words[fim].end,
    });
    n++;
    i = fim + 1;
  }

  return { words: out, n };
}
