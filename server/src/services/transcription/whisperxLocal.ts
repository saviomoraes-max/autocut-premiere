// Transcritor WhisperX local: chama o binário do venv como subprocesso,
// lê o JSON gerado e normaliza pra `TranscriptResult`.
//
// Invocação equivalente à manual:
//   whisperx audio.wav --model large-v3 --language pt \
//     --align_model jonatasgrosman/wav2vec2-large-xlsr-53-portuguese \
//     --device cpu --compute_type int8 --output_format json --output_dir <tmp>
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../../config";
import { log } from "../../logger";
import type { Transcriber, TranscribeOptions } from "./types";
import type { TranscriptResult, Word } from "../../../../shared/types";

// Schema parcial do JSON que o WhisperX grava.
interface WhisperxWord {
  word: string;
  start?: number; // o forced-align pode não atribuir tempo a dígitos/símbolos
  end?: number;
  score?: number;
}
interface WhisperxJson {
  segments?: Array<{ start: number; end: number; text: string; words?: WhisperxWord[] }>;
  word_segments?: WhisperxWord[];
  language?: string;
}

export class WhisperxTranscriber implements Transcriber {
  readonly name = "whisperx" as const;

  async transcribe(wavPath: string, opts: TranscribeOptions): Promise<TranscriptResult> {
    const outDir = await mkdtemp(path.join(tmpdir(), "autocut-wx-"));
    try {
      const args = [
        wavPath,
        "--model", config.whisperx.model,
        "--language", opts.language,
        "--align_model", config.whisperx.alignModel,
        "--device", config.whisperx.device,
        "--compute_type", config.whisperx.computeType,
        "--batch_size", String(config.whisperx.batchSize),
        // Anti-alucinação: não condiciona no texto anterior (tira o loop de "......." que
        // engolia trechos de fala). Configurável por WHISPERX_CONDITION_PREV.
        "--condition_on_previous_text", config.whisperx.conditionOnPreviousText ? "True" : "False",
        "--output_format", "json",
        "--output_dir", outDir,
        "--print_progress", "True",
      ];
      // --initial_prompt ensina nomes próprios/jargões ao modelo (vocabulário-guia de domínio,
      // NÃO instrução de corte). opts.prompt sobrescreve o default da config, se vier.
      const initialPrompt = opts.prompt || config.whisperx.initialPrompt;
      if (initialPrompt) args.push("--initial_prompt", initialPrompt);

      await runWhisperx(config.whisperx.bin, args, opts.signal);

      // O WhisperX grava <basename-sem-ext>.json dentro do outDir.
      const base = path.basename(wavPath).replace(/\.[^.]+$/, "");
      const jsonPath = path.join(outDir, `${base}.json`);
      const raw = JSON.parse(await readFile(jsonPath, "utf8")) as WhisperxJson;

      const words = normalizeWords(raw);
      const text = (raw.segments ?? [])
        .map((s) => s.text.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const durationSec = words.length ? words[words.length - 1].end : 0;

      return { words, text, language: raw.language ?? opts.language, durationSec, engine: "whisperx" };
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
}

/**
 * Usa `word_segments` (lista achatada de todas as palavras); na falta, achata
 * `segments[].words`. Preenche start/end ausentes com o fim da palavra anterior
 * pra não abrir buraco na linha do tempo.
 */
function normalizeWords(raw: WhisperxJson): Word[] {
  const src: WhisperxWord[] =
    raw.word_segments && raw.word_segments.length
      ? raw.word_segments
      : (raw.segments ?? []).flatMap((s) => s.words ?? []);

  const out: Word[] = [];
  let lastEnd = 0;
  for (const w of src) {
    // Descarta tokens que são SÓ pontuação (ex.: "." soltos que o Whisper alucina num trecho
    // sem fala clara) — não são palavras, virariam legenda vazia e poluem o transcript.
    if (!w.word || !w.word.replace(/[\s.,;:!?…"'"'’“”«»¡¿()\[\]{}—–-]/gu, "")) continue;
    const start = typeof w.start === "number" ? w.start : lastEnd;
    const end = typeof w.end === "number" ? w.end : start;
    lastEnd = end;
    out.push({ word: w.word, start, end, score: w.score });
  }
  return out;
}

function runWhisperx(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Já cancelado antes de começar: nem dispara.
    if (signal?.aborted) return reject(new Error("Transcrição cancelada."));

    log.info("WhisperX", bin, args.join(" "));
    // `signal` faz o Node mandar SIGTERM no subprocesso quando o cliente cancela.
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stderr = "";
    let cancelado = false;

    const onAbort = () => {
      cancelado = true;
      log.info("Transcrição cancelada — matando o WhisperX.");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      // AbortError (subprocesso morto pelo signal) vira um cancelamento limpo.
      if (cancelado || (err as NodeJS.ErrnoException).name === "AbortError") {
        reject(new Error("Transcrição cancelada."));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (cancelado) reject(new Error("Transcrição cancelada."));
      else if (code === 0) resolve();
      else reject(new Error(`WhisperX saiu com código ${code}.\n${stderr.slice(-2000)}`));
    });
  });
}
