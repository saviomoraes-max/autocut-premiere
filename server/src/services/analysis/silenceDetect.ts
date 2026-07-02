// Detecção ACÚSTICA de silêncio via filtro silencedetect do ffmpeg.
// (O teste com dado real mostrou que o gap entre palavras da transcrição é
//  pouco confiável — o forced-align absorve a pausa na palavra anterior —,
//  então o silêncio é detectado pelo áudio, não pelos timestamps.)
import { spawn } from "node:child_process";
import { config } from "../../config";
import { log } from "../../logger";
import type { Cut } from "../../../../shared/types";

export interface SilenceOptions {
  thresholdDb?: number;
  minSilenceSec?: number;
}

export async function detectSilences(
  wavPath: string,
  durationSec: number,
  opts: SilenceOptions = {},
): Promise<Cut[]> {
  const thr = opts.thresholdDb ?? config.silence.thresholdDb;
  const minSil = opts.minSilenceSec ?? config.silence.minSilenceSec;
  const stderr = await runSilenceDetect(wavPath, thr, minSil);
  return parseSilences(stderr, durationSec);
}

// Lê os pares silence_start / silence_end do log do ffmpeg.
export function parseSilences(stderr: string, durationSec: number): Cut[] {
  const cuts: Cut[] = [];
  let curStart: number | null = null;

  for (const line of stderr.split("\n")) {
    const ms = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (ms) {
      curStart = Math.max(0, parseFloat(ms[1]));
      continue;
    }
    const me = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (me && curStart != null) {
      const end = parseFloat(me[1]);
      if (end > curStart) {
        cuts.push({
          start: curStart,
          end,
          reason: "silencio",
          detail: `${(end - curStart).toFixed(1)}s de silêncio`,
        });
      }
      curStart = null;
    }
  }

  // Silêncio que vai até o fim do áudio (sem silence_end no log).
  if (curStart != null && durationSec > curStart) {
    cuts.push({
      start: curStart,
      end: durationSec,
      reason: "silencio",
      detail: `${(durationSec - curStart).toFixed(1)}s de silêncio (final)`,
    });
  }

  return cuts;
}

function runSilenceDetect(wavPath: string, thr: number, minSil: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-nostats",
      "-i",
      wavPath,
      "-af",
      `silencedetect=noise=${thr}dB:d=${minSil}`,
      "-f",
      "null",
      "-",
    ];
    log.info("ffmpeg silencedetect", args.join(" "));
    const child = spawn(config.ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    // silencedetect escreve no stderr.
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`silencedetect saiu com código ${code}`)),
    );
  });
}
