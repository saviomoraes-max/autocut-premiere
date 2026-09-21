// FEATURE "trecho refeito" (21/set/2026) — o retake do jeito que ele REALMENTE acontece nos
// brutos do Léo, medido nas 60 transcrições em cache e no bruto de teste:
//
//   1. recado pro editor no meio:  "…tem paciente de 5 mil ou mais decidindo agora, nesse exato
//      momento, decidindo com quem vai fazer a harmonização dela. Na sua cidade, independente…
//      MANO, TÁ MUITO RUIM ISSO, PERAÍ. MUITA PONTUAÇÃO.  Enquanto você espera ter caso
//      suficiente para divulgar, tem paciente de 5 mil ou mais decidindo agora…"
//   2. sem aviso nenhum:  "Deixa eu te tirar um peso, TU tá certa mesmo. Agora já deixa eu te
//      tirar um peso, VOCÊ tá certa mesmo…"
//   3. colado:  "Peraí, eu desconcentrei. É… Não é boleto de mais um curso. Não é boleto de mais
//      um curso."
//
// O que separa retake de conteúdo NÃO é a frase-chave ("na turma seguinte, tudo de novo" é
// conteúdo) — é o RECOMEÇO: depois do tropeço, a fala repete o que vinha sendo dito. Então o
// detector procura repetição de sequência de palavras e corta a tentativa ANTERIOR, mantendo a
// última (que é a boa, por definição: é a que o chefe deixou valer).
//
// Por que isto e não o repeatedTakeDetect: aquele compara SENTENÇA inteira por Jaccard e exige
// 4 s de separação — perde o recomeço colado (caso 3) e o recomeço no meio da frase (caso 1).
// Os dois convivem: este pega o recomeço, aquele pega o take inteiro regravado minutos depois.
import type { Cut, Word } from "../../../../shared/types";
import { jaccard, norm, shingles } from "./sentences";

/** Palavras de recado pro editor — evidência FORTE de que o trecho anterior foi descartado. */
const META =
  /^(pera[ií]+|pera|espera|opa|mano|caramba|caraca|desculpa|foi|errei|desconcentrei|travei|perdi|ruim|feio|horr[ií]vel|corta|apaga|deleta|repete|repetindo|refazer|regravar)$/;

export interface RetakeSpanOptions {
  /** Palavras iguais seguidas que provam o recomeço (a "impressão digital" da retomada). */
  minRun?: number;
  /** Quanto tempo atrás procurar a tentativa anterior. */
  lookbackSec?: number;
  /** Corte máximo que este detector propõe sozinho (trava de segurança). */
  maxSpanSec?: number;
  /** Sem recado nem fala cortada no meio, exige esta sequência repetida (mais rigor). */
  minRunSemEvidencia?: number;
  /**
   * Semelhança mínima (Jaccard de bigramas) entre o trecho descartado e o que vem no lugar.
   * É ESTE portão que separa retake de FRASE QUE VOLTA: nos brutos de matriz (um corpo, vários
   * ganchos) linhas inteiras se repetem em peças diferentes ("o lote um tá liberado") e só o
   * gancho casa — o resto do trecho é conteúdo diferente, e cortar apagaria peça boa.
   * Medido nas transcrições reais: retake de verdade fica acima de 0,35; frase que volta, abaixo.
   */
  minSemelhanca?: number;
  /** Trecho curto (≤ isto de palavras) com evidência no meio dispensa o portão de semelhança. */
  curtoSemPortao?: number;
  /** Até esta duração o corte entra MARCADO; acima, entra desmarcado pra decisão do editor. */
  marcaAteSec?: number;
}

interface Tok {
  t: string;
  i: number; // índice da palavra na transcrição
  start: number;
  end: number;
}

/** Palavras normalizadas, sem os tokens vazios (pontuação solta). */
function tokenizar(words: Word[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < words.length; i++) {
    const t = norm(words[i].word);
    if (t) out.push({ t, i, start: words[i].start, end: words[i].end });
  }
  return out;
}

/** Quantas palavras seguem iguais a partir de (a, b), tolerando 1 troca a cada 5 (reformulação). */
function comprimentoDoCasamento(toks: Tok[], a: number, b: number, limite: number): number {
  let n = 0;
  let erros = 0;
  while (a + n < b && b + n < toks.length && n < limite) {
    if (toks[a + n].t === toks[b + n].t) {
      n++;
      continue;
    }
    // uma palavra trocada ("tu"→"você") não quebra o recomeço, mas duas seguidas sim
    if (erros < Math.floor(n / 5) + 1 && a + n + 1 < b && toks[a + n + 1].t === toks[b + n + 1]?.t) {
      erros++;
      n++;
      continue;
    }
    break;
  }
  return n;
}

/**
 * Acha os trechos refeitos e devolve o corte da tentativa ANTERIOR (reason "bad_take").
 * O corte vai do início da tentativa velha até a palavra imediatamente antes do recomeço —
 * ou seja, leva junto o recado pro editor e a hesitação do meio.
 */
export function detectRetakeSpanCuts(words: Word[], opts: RetakeSpanOptions = {}): Cut[] {
  const minRun = opts.minRun ?? 4;
  const lookback = opts.lookbackSec ?? 60;
  const maxSpan = opts.maxSpanSec ?? 90;
  const minRunSemEvidencia = opts.minRunSemEvidencia ?? 6;
  const minSemelhanca = opts.minSemelhanca ?? 0.35;
  const curtoSemPortao = opts.curtoSemPortao ?? 8;

  const toks = tokenizar(words);
  if (toks.length < minRun * 2) return [];

  // índice: n-grama → posições onde ele começa (pra achar a tentativa anterior sem varrer tudo)
  const chave = (p: number) => toks.slice(p, p + minRun).map((x) => x.t).join(" ");
  const ondeApareceu = new Map<string, number[]>();
  for (let p = 0; p + minRun <= toks.length; p++) {
    const k = chave(p);
    const lista = ondeApareceu.get(k);
    if (lista) lista.push(p);
    else ondeApareceu.set(k, [p]);
  }

  const cortes: Cut[] = [];
  let jaCortadoAte = -1; // índice de token: não propõe cortes sobrepostos

  for (let j = 0; j + minRun <= toks.length; j++) {
    if (j <= jaCortadoAte) continue;
    const anteriores = ondeApareceu.get(chave(j));
    if (!anteriores || anteriores.length < 2) continue;

    // Testa CADA tentativa anterior e fica com a melhor que passa em todos os portões (antes eu
    // ficava só com a de maior repetição e, se ela era rejeitada, perdia o retake que estava logo
    // ali — foi o que apagou o bruto de 5 takes seguidos do mesmo anúncio).
    interface Candidato {
      i: number;
      run: number;
      semelhanca: number;
      porque: string;
    }
    let escolhido: Candidato | null = null;
    for (const i of anteriores) {
      if (i >= j) break;
      if (i <= jaCortadoAte) continue;
      if (toks[j].start - toks[i].start > lookback) continue;
      const run = comprimentoDoCasamento(toks, i, j, 40);
      if (run < minRun) continue;

      const inicio = toks[i].start;
      const fim = toks[j].start; // corta até o recomeço (exclusivo)
      if (fim - inicio <= 0 || fim - inicio > maxSpan) continue;

      // evidência no miolo: recado pro editor, fala cortada ("--") ou pausa longa
      let temMeta = false;
      let temCortada = false;
      let maiorPausa = 0;
      for (let p = i; p < j; p++) {
        if (META.test(toks[p].t)) temMeta = true;
        if (/-{2,}$/.test(words[toks[p].i].word.trim())) temCortada = true;
        if (p > i) maiorPausa = Math.max(maiorPausa, toks[p].start - toks[p - 1].end);
      }
      // Repetição COLADA ("o anúncio que trouxe, o anúncio que trouxe…"): o trecho inteiro é
      // redito na sequência, sem pausa nem recado. É gagueira de gravação e vale corte curto.
      const nSpanTok = j - i;
      const colada = nSpanTok <= curtoSemPortao && run >= nSpanTok && toks[j].start - toks[i].start <= 4;
      const evidencia = temMeta || temCortada || maiorPausa >= 1.2 || colada;
      if (!evidencia && run < minRunSemEvidencia) continue;

      // PORTÃO: o trecho descartado tem que ser MESMO refeito — compara ele inteiro com o que vem
      // no lugar (mesmo número de palavras). Tropeço curto com evidência no meio passa direto.
      const nSpan = nSpanTok;
      const semelhanca = jaccard(
        shingles(toks.slice(i, j).map((x) => x.t), 2),
        shingles(toks.slice(j, j + nSpan).map((x) => x.t), 2),
      );
      if (!(evidencia && nSpan <= curtoSemPortao) && semelhanca < minSemelhanca) continue;

      const porque = temCortada
        ? "fala cortada"
        : temMeta
          ? "recado pro editor"
          : maiorPausa >= 1.2
            ? "pausa"
            : colada
              ? "repetição colada"
              : `${run} palavras repetidas`;
      // entre os que passam, fica com o de maior repetição (a tentativa mais completa)
      if (!escolhido || run > escolhido.run) escolhido = { i, run, semelhanca, porque };
    }
    if (!escolhido) continue;

    const i = escolhido.i;
    const melhorRun = escolhido.run;
    const inicio = toks[i].start;
    const fim = toks[j].start;
    const porque = escolhido.porque;
    const conf = `${(escolhido.semelhanca * 100).toFixed(0)}% igual`;
    // Corte longo ou parecido "mais ou menos" entra DESMARCADO: pode ser outra peça da matriz,
    // não uma regravação. Curto com evidência clara entra marcado.
    const forte = escolhido.porque !== `${melhorRun} palavras repetidas` || escolhido.semelhanca >= 0.6;
    const revisar = !forte || fim - inicio > (opts.marcaAteSec ?? 20);

    const trecho = words
      .slice(toks[i].i, toks[j].i)
      .map((w) => w.word)
      .join(" ")
      .trim();
    const retomada = toks
      .slice(j, j + melhorRun)
      .map((t) => words[t.i].word)
      .join(" ")
      .trim();
    cortes.push({
      start: inicio,
      end: fim,
      reason: "bad_take",
      detail: `trecho refeito (${porque}, ${conf}): "${resumir(trecho)}" → retomou "${resumir(retomada)}"`,
      review: revisar || undefined,
    });
    jaCortadoAte = j - 1;
  }
  return cortes;
}

function resumir(s: string, max = 70): string {
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}
