// Gera o .srt no padrão do plugin Legendas RECONECTA, REUSANDO os mesmos scripts do skill
// vsl-editor (garante saída idêntica, sem duplicar a lógica de chunking/dinheiro/nomes):
//   1. postprocess-transcript.mjs  → corrige nomes próprios (correcoes.json) + dinheiro ("N mil reais")
//   2. srt.mjs --max-chars 14 --min-dur 1.6 --gap 0 --max-words 12 --offset <TC> --lead <0.10>
// Formato HH:MM:SS,mmm. Roda os .mjs com o MESMO node que roda o backend (process.execPath).
//
// DOIS ESTILOS (seletor do painel, 28/ago) — as MESMAS palavras transcritas, montagens diferentes:
//   "reels"  = o de sempre. 1 linha de 14 chars, min 1,6s, gap 0 → ~1 palavra por legenda.
//   "cinema" = frase inteira legível: até 2 linhas de 42 chars, min 5/6 s, max 7s, gap de 2
//              frames, teto de 17 caracteres/segundo. Dinheiro em numeral ("R$ 40.000").
// A quebra em 2 linhas e o teto de leitura são feitos AQUI (módulo `cinema`), não no srt.mjs —
// aquele script é compartilhado com o plugin Legendas e com o vsl-editor e não pode mudar.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../../config";
import { log } from "../../logger";
import { applyReadingSpeed, mergeShortCues, parseSrt, serializeSrt, wrapCue } from "./cinema";
import { expandMoneyScale, mergeMoneyToNumeral } from "./money";
import { limparFalaCortada } from "./limpeza";
import type { CaptionStyle, Word } from "../../../../shared/types";

/** Roda `node <script> <args...>` e resolve quando termina (rejeita com o stderr no erro). */
function runNode(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} saiu com código ${code}.\n${stderr.slice(-1500)}`));
    });
  });
}

export interface SrtOptions {
  /** Segundos somados a cada legenda — encaixa no timecode/posição da sequência. */
  offsetSec?: number;
  /** Adianta TODAS as legendas em N s (sincronia fina). Default do config (0.10). */
  leadSec?: number;
  /** Estilo de montagem da legenda. Default "reels" (o comportamento histórico). */
  style?: CaptionStyle;
  /** FPS da sequência — só o cinema usa, pra converter o gap de frames em segundos. */
  fps?: number;
}

// Pontuação a remover (estilo legenda minúscula). Mantém letras (com acento), dígitos e
// espaços; tira ponto/vírgula/interrogação/aspas/parênteses/travessão etc.
const PONTUACAO = /[.,;:!?…"'"'’“”«»¡¿()\[\]{}—–]/g;

// Montante em numeral produzido pelo `mergeMoneyToNumeral` (estilo cinema). Precisa atravessar
// o passo minúsculo-sem-pontuação INTACTO: sem essa guarda, "R$ 40.000" viraria "r$ 40000"
// (o ponto de milhar é pontuação e o R vira minúsculo). Aceita vírgula DECIMAL ("R$ 1,5 milhão" —
// sem ela saía "R$ 15 milhão", visto no teste de 21/09). Termina obrigatoriamente em DÍGITO,
// pra não engolir o ponto final da frase em "…custou R$ 40.000." (esse ponto tem que cair).
const MOEDA_NUMERAL = /R\$\s?\d(?:[\d.,]*\d)?/g;
// Marcador temporário do montante durante o passo de caixa/pontuação. Usa um caractere de
// controle de propósito: não é pontuação (não é removido), não tem caixa (toLowerCase não
// mexe) e não existe em transcrição — um marcador numérico colidiria com número de verdade.
const MARCA = "\u0001";

/**
 * ESTILO (pedido do Sávio): texto das legendas em MINÚSCULO, SEM pontuação, preservando só
 * as marcas em caixa alta (RECONECTA/SUPERCASO — a forma que o postprocess já produziu, então
 * o VERBO "reconecta" minúsculo NÃO é afetado) e os montantes em R$. Vale para os DOIS estilos:
 * o cinema muda o formato da legenda, não a régua de escrita. Não toca no índice nem no
 * timestamp do .srt.
 */
function aplicarEstiloMinusculo(srtText: string): string {
  const marcas = new Set(config.srt.brandUpper); // match case-sensitive
  const transformarLinha = (linha: string): string => {
    // Tira os montantes de cena antes de baixar a caixa/remover pontuação, e recoloca no fim.
    // O marcador (\u0001N\u0001) não tem pontuação nem letra, então atravessa o map intacto.
    const guardados: string[] = [];
    const comMarcador = linha.replace(MOEDA_NUMERAL, (m) => {
      guardados.push(m);
      return `${MARCA}${guardados.length - 1}${MARCA}`;
    });
    const transformado = comMarcador
      .split(/\s+/)
      .map((tok) => {
        const limpo = tok.replace(PONTUACAO, "");
        if (!limpo) return "";
        if (marcas.has(limpo)) return limpo; // marca em caixa alta → preserva
        return limpo.toLowerCase();
      })
      .filter(Boolean)
      .join(" ");
    return transformado.replace(new RegExp(`${MARCA}(\\d+)${MARCA}`, "g"), (_, i: string) => guardados[Number(i)] ?? "");
  };

  return srtText
    .split("\n")
    .map((linha) => {
      if (linha.trim() === "") return linha; // linha em branco entre cues
      if (/^\d+$/.test(linha.trim())) return linha; // índice da legenda
      if (linha.includes("-->")) return linha; // linha de timestamp
      return transformarLinha(linha); // linha de TEXTO
    })
    .join("\n");
}

/**
 * Transforma as palavras transcritas no .srt do padrão Legendas RECONECTA. Devolve o texto
 * do .srt + a contagem de legendas. NÃO escreve em disco do usuário — quem chama (o painel)
 * salva onde o usuário escolher.
 */
export async function buildSrtLegendas(
  words: Word[],
  opts: SrtOptions = {},
): Promise<{ srt: string; count: number }> {
  // Confere que os scripts do skill existem (mesma dependência do WhisperX).
  for (const s of [config.srt.postprocessScript, config.srt.srtScript]) {
    try {
      await access(s);
    } catch {
      throw new Error(
        `Script de legenda não encontrado: ${s}. (Faz parte do skill vsl-editor; ajuste SRT_SCRIPT/SRT_POSTPROCESS se moveu.)`,
      );
    }
  }

  const style: CaptionStyle = opts.style ?? "reels";
  const cine = config.srtCinema;
  // O gap entre legendas do cinema é medido em FRAMES → precisa do fps da sequência.
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;

  const dir = await mkdtemp(path.join(tmpdir(), "autocut-srt-"));
  try {
    const inJson = path.join(dir, "in.json");
    const postJson = path.join(dir, "post.json");
    const outSrt = path.join(dir, "out.srt");

    // Fala cortada ("segurava--", marca do Scribe verbatim) não entra na legenda, nos dois estilos.
    const corte = limparFalaCortada(words);
    let entrada = corte.words;
    if (corte.n) log.info(`Legenda: ${corte.n} marca(s) de fala cortada removida(s) do texto.`);

    // No CINEMA o dinheiro sai em NUMERAL: cada montante vira um token único já formatado
    // ANTES do postprocess, que então não o converte pra "40 mil reais". As correções de
    // nome próprio (correcoes.json) continuam rodando normalmente nos dois estilos.
    if (style === "cinema" && cine.moneyNumeral) {
      const m = mergeMoneyToNumeral(entrada);
      entrada = m.words;
      if (m.n) log.info(`Cinema: ${m.n} montante(s) mantido(s) em numeral (ex.: "R$ 40.000").`);
    } else if (style === "reels") {
      // "R$ 62 mil" → "R$62.000", pra regra da casa escrever "62 mil reais" (e não "62 reais mil").
      const m = expandMoneyScale(entrada);
      entrada = m.words;
      if (m.n) log.info(`Reels: ${m.n} valor(es) com escala preparado(s) pra forma falada.`);
    }

    // O postprocess aceita array flat [{word,start,end}] — exatamente o que temos.
    const flat = entrada.map((w) => ({ word: w.word, start: w.start, end: w.end }));
    await writeFile(inJson, JSON.stringify(flat), "utf8");

    // 1) nomes próprios (correcoes.json) + dinheiro por extenso (neutralizado acima no cinema).
    await runNode(config.srt.postprocessScript, [inJson, postJson]);

    // 2) monta o .srt. O srt.mjs faz o agrupamento, o offset e o lead nos DOIS estilos — muda
    //    só o orçamento de cada legenda. No cinema o orçamento é o das duas linhas somadas
    //    (42×2); a quebra em si acontece no passo 3, aqui dentro do AutoCut.
    // Orçamento de caracteres da legenda de cinema: as duas linhas somadas, MENOS uma folga —
    // sem ela quase nenhuma legenda de 84 chars tem fronteira de palavra que caiba em 42+42.
    const orcamento = cine.maxCharsPerLine * cine.maxLines - cine.cueMargin;
    const preset =
      style === "cinema"
        ? [
            "--max-chars", String(orcamento),
            "--min-dur", String(cine.minDur),
            "--max-dur", String(cine.maxDur),
            "--max-gap", String(cine.maxGapSec),
            "--gap", String(cine.gapFrames),
            "--fps", String(fps),
            "--max-words", String(cine.maxWords),
          ]
        : [
            "--max-chars", String(config.srt.maxChars),
            "--min-dur", String(config.srt.minDur),
            "--gap", String(config.srt.gap),
            "--max-words", String(config.srt.maxWords),
          ];
    await runNode(config.srt.srtScript, [
      postJson,
      outSrt,
      ...preset,
      "--offset", String(opts.offsetSec ?? 0),
      "--lead", String(opts.leadSec ?? config.srt.lead),
    ]);

    let srt = await readFile(outSrt, "utf8");

    // 3) CINEMA: quebra cada legenda em até 2 linhas e estica a duração pra caber na
    //    velocidade de leitura. O reels pula tudo isso e sai como sempre saiu.
    if (style === "cinema") {
      // 3a) funde as legendas órfãs (palavra solta piscando) na vizinha, ANTES de quebrar —
      //     a quebra tem que enxergar o texto final.
      const { cues: juntas, fundidas } = mergeShortCues(parseSrt(srt), {
        minDur: cine.minDur,
        maxDur: cine.maxDur,
        maxChars: orcamento,
        maxGapSec: cine.maxGapSec,
        minWords: cine.orphanWords,
      });
      // 3b) quebra cada legenda em até 2 linhas.
      const quebradas = juntas.map((c) => ({
        ...c,
        text: wrapCue(c.text, cine.maxCharsPerLine, cine.maxLines),
      }));
      const linhasLongas = quebradas.reduce(
        (n, c) => n + c.text.split("\n").filter((l) => l.length > cine.maxCharsPerLine).length,
        0,
      );
      const { cues: ajustadas, acimaDoTeto } = applyReadingSpeed(quebradas, {
        cps: cine.cps,
        minDur: cine.minDur,
        maxDur: cine.maxDur,
        gapSec: cine.gapFrames / fps,
      });
      srt = serializeSrt(ajustadas);
      log.info(
        `Cinema: ${ajustadas.length} legendas · ${cine.maxCharsPerLine}×${cine.maxLines} chars (orçamento ${orcamento}) · teto ${cine.cps} cps · gap ${cine.gapFrames}f @ ${fps}fps · ${fundidas} órfã(s) fundida(s).`,
      );
      if (linhasLongas)
        log.info(`  ${linhasLongas} linha(s) acima de ${cine.maxCharsPerLine} chars (sem ponto de quebra melhor).`);
      if (acimaDoTeto)
        log.info(`  ${acimaDoTeto} legenda(s) acima de ${cine.cps} cps (sem espaço na timeline pra esticar).`);
    }

    // 4) Passo de estilo: minúsculo + sem pontuação (exceto marcas em caixa alta e R$).
    //    Vale nos DOIS estilos — o cinema muda o formato, não a régua de escrita.
    if (config.srt.lowercaseNoPunct) srt = aplicarEstiloMinusculo(srt);
    const count = (srt.match(/-->/g) ?? []).length;
    log.info(
      `SRT gerado (${style}): ${count} legendas (offset ${opts.offsetSec ?? 0}s, lead ${opts.leadSec ?? config.srt.lead}s).`,
    );
    return { srt, count };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
