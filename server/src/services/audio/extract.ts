// Extração de áudio com ffmpeg. Converte (e opcionalmente recorta) um arquivo
// de mídia para WAV PCM 16kHz mono — o formato ideal pra ASR (Whisper/WhisperX).
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../../config";
import { log } from "../../logger";

export interface ExtractOptions {
  /** Início do trecho na mídia de origem (segundos). */
  inSec?: number;
  /** Fim do trecho na mídia de origem (segundos). */
  outSec?: number;
}

/**
 * Extrai o áudio de `mediaPath` para um WAV temporário e retorna o caminho.
 * Quem chamou é responsável por limpar o diretório temporário depois.
 */
export async function extractAudioToWav(
  mediaPath: string,
  opts: ExtractOptions = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "autocut-audio-"));
  const wavPath = path.join(dir, "audio.wav");

  const args: string[] = ["-y", "-hide_banner"];
  // -ss ANTES de -i = seek rápido até o in point.
  if (typeof opts.inSec === "number" && opts.inSec > 0) {
    args.push("-ss", String(opts.inSec));
  }
  args.push("-i", mediaPath);
  // -t = duração do trecho (out - in). Se só veio outSec sem inSec, usa-o como duração.
  if (
    typeof opts.outSec === "number" &&
    typeof opts.inSec === "number" &&
    opts.outSec > opts.inSec
  ) {
    args.push("-t", String(opts.outSec - opts.inSec));
  } else if (typeof opts.outSec === "number" && !opts.inSec && opts.outSec > 0) {
    args.push("-t", String(opts.outSec));
  }
  // Sem vídeo, mono, 16kHz, PCM 16 bits.
  args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath);

  await runFfmpeg(args);
  return wavPath;
}

/**
 * Concatena vários WAVs (todos no mesmo formato: 16kHz mono PCM) num único WAV
 * contínuo — o "stream achatado" usado quando o Auto-Edit roda em vários clips.
 * Re-encoda (em vez de `-c copy`) pra garantir um header WAV limpo no resultado.
 * Retorna o caminho; quem chamou limpa o diretório temporário depois.
 */
export async function concatWavsToWav(wavPaths: string[]): Promise<string> {
  if (wavPaths.length === 0) {
    throw new Error("concatWavsToWav: nenhum WAV pra concatenar.");
  }
  if (wavPaths.length === 1) {
    return wavPaths[0]; // nada a concatenar
  }
  const dir = await mkdtemp(path.join(tmpdir(), "autocut-concat-"));
  const listPath = path.join(dir, "list.txt");
  const outPath = path.join(dir, "audio.wav");

  // Demuxer concat do ffmpeg: uma linha "file '<caminho>'" por slice. Aspas
  // simples internas são escapadas no formato que o ffmpeg espera ('\'').
  const list = wavPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, list, "utf8");

  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
  return outPath;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    log.info("ffmpeg", args.join(" "));
    const child = spawn(config.ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg saiu com código ${code}:\n${stderr.slice(-1000)}`));
    });
  });
}
