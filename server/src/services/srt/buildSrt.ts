// Gera o .srt no padrão do plugin Legendas RECONECTA, REUSANDO os mesmos scripts do skill
// vsl-editor (garante saída idêntica, sem duplicar a lógica de chunking/dinheiro/nomes):
//   1. postprocess-transcript.mjs  → corrige nomes próprios (correcoes.json) + dinheiro ("N mil reais")
//   2. srt.mjs --max-chars 14 --min-dur 1.6 --gap 0 --max-words 12 --offset <TC> --lead <0.10>
// Formato HH:MM:SS,mmm. Roda os .mjs com o MESMO node que roda o backend (process.execPath).
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../../config";
import { log } from "../../logger";
import type { Word } from "../../../../shared/types";

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
}

// Pontuação a remover (estilo legenda minúscula). Mantém letras (com acento), dígitos e
// espaços; tira ponto/vírgula/interrogação/aspas/parênteses/travessão etc.
const PONTUACAO = /[.,;:!?…"'"'’“”«»¡¿()\[\]{}—–]/g;

/**
 * ESTILO (pedido do Sávio): texto das legendas em MINÚSCULO, SEM pontuação, preservando só
 * as marcas em caixa alta (RECONECTA/SUPERCASO — a forma que o postprocess já produziu, então
 * o VERBO "reconecta" minúsculo NÃO é afetado). Não toca no índice nem no timestamp do .srt.
 */
function aplicarEstiloMinusculo(srtText: string): string {
  const marcas = new Set(config.srt.brandUpper); // match case-sensitive
  const transformarLinha = (linha: string): string =>
    linha
      .split(/\s+/)
      .map((tok) => {
        const limpo = tok.replace(PONTUACAO, "");
        if (!limpo) return "";
        if (marcas.has(limpo)) return limpo; // marca em caixa alta → preserva
        return limpo.toLowerCase();
      })
      .filter(Boolean)
      .join(" ");

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

  const dir = await mkdtemp(path.join(tmpdir(), "autocut-srt-"));
  try {
    const inJson = path.join(dir, "in.json");
    const postJson = path.join(dir, "post.json");
    const outSrt = path.join(dir, "out.srt");

    // O postprocess aceita array flat [{word,start,end}] — exatamente o que temos.
    const flat = words.map((w) => ({ word: w.word, start: w.start, end: w.end }));
    await writeFile(inJson, JSON.stringify(flat), "utf8");

    // 1) nomes próprios (correcoes.json) + dinheiro por extenso.
    await runNode(config.srt.postprocessScript, [inJson, postJson]);

    // 2) monta o .srt com o preset "Create Captions" do Premiere.
    await runNode(config.srt.srtScript, [
      postJson,
      outSrt,
      "--max-chars", String(config.srt.maxChars),
      "--min-dur", String(config.srt.minDur),
      "--gap", String(config.srt.gap),
      "--max-words", String(config.srt.maxWords),
      "--offset", String(opts.offsetSec ?? 0),
      "--lead", String(opts.leadSec ?? config.srt.lead),
    ]);

    let srt = await readFile(outSrt, "utf8");
    // Passo de estilo: minúsculo + sem pontuação (exceto marcas em caixa alta).
    if (config.srt.lowercaseNoPunct) srt = aplicarEstiloMinusculo(srt);
    const count = (srt.match(/-->/g) ?? []).length;
    log.info(`SRT gerado: ${count} legendas (offset ${opts.offsetSec ?? 0}s, lead ${opts.leadSec ?? config.srt.lead}s).`);
    return { srt, count };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
