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
  /** Respiro mínimo (s) deixado do lado da palavra ANTERIOR (o decaimento da voz). */
  margemInicioSec?: number;
  /** Respiro mínimo (s) deixado do lado da palavra SEGUINTE (o ataque, mais abrupto). */
  margemFimSec?: number;
}

/**
 * RESPIRO MEDIDO, não chutado (23/set/2026). Antes cada corte de silêncio encolhia um valor FIXO
 * (0,12 s de cada lado no Natural) pra não comer o decaimento da voz — e sobrava ~0,34 s de ar em
 * TODO corte (medido no bruto de 93 min do Sávio: 20 s de sobra a cada 3 min).
 *
 * Medição do mesmo áudio: o decaimento real da voz dura 15–20 ms na mediana e 139 ms no percentil
 * 90. Ou seja, o valor fixo era 6× maior que o necessário quase sempre, e curto demais de vez em
 * quando. Então agora se mede: uma segunda passada do silencedetect num limiar bem mais baixo
 * ("miolo" do silêncio, onde não há NADA audível) diz onde o som realmente acabou.
 *
 * Borda do corte = a mais conservadora entre o miolo e a margem do preset:
 *     início = max(miolo.início, pausa.início + margemInício)
 *     fim    = min(miolo.fim,    pausa.fim    − margemFim)
 * Sem miolo (sala barulhenta, música), cai no comportamento antigo com a margem antiga (0,12 s).
 */
export async function detectSilences(
  wavPath: string,
  durationSec: number,
  opts: SilenceOptions = {},
): Promise<Cut[]> {
  const thr = opts.thresholdDb ?? config.silence.thresholdDb;
  const minSil = opts.minSilenceSec ?? config.silence.minSilenceSec;
  const margemIni = Math.max(0, opts.margemInicioSec ?? config.silence.margemInicioSec);
  const margemFim = Math.max(0, opts.margemFimSec ?? config.silence.margemFimSec);

  const pausas = parseSilences(await runSilenceDetect(wavPath, thr, minSil), durationSec);
  if (!pausas.length) return [];

  // 2ª passada: o MIOLO do silêncio (nada audível). d curto pra pegar miolo de pausa curta.
  let miolos: Cut[] = [];
  try {
    miolos = parseSilences(
      await runSilenceDetect(wavPath, config.silence.coreThresholdDb, 0.04),
      durationSec,
    );
  } catch (err) {
    log.info(`silencedetect do miolo falhou (${(err as Error).message}) — usando a margem fixa.`);
  }

  const SEM_MIOLO = 0.12; // margem antiga, usada só onde não há miolo (o conservador de antes)
  let comMiolo = 0;
  let sobra = 0;
  const cortes: Cut[] = [];
  for (const p of pausas) {
    const dentro = miolos.filter((m) => m.end > p.start && m.start < p.end);
    let inicio: number;
    let fim: number;
    if (dentro.length) {
      comMiolo++;
      const mIni = Math.max(p.start, Math.min(...dentro.map((m) => m.start)));
      const mFim = Math.min(p.end, Math.max(...dentro.map((m) => m.end)));
      inicio = Math.max(mIni, p.start + margemIni);
      fim = Math.min(mFim, p.end - margemFim);
    } else {
      inicio = p.start + Math.max(margemIni, SEM_MIOLO);
      fim = p.end - Math.max(margemFim, SEM_MIOLO);
    }
    if (fim - inicio < 0.08) continue; // sobrou pouco: não vale um corte
    sobra += p.end - p.start - (fim - inicio);
    cortes.push({ ...p, start: inicio, end: fim });
  }
  log.info(
    `Silêncio: ${pausas.length} pausa(s), ${comMiolo} com miolo medido · ${cortes.length} corte(s) · ` +
      `respiro deixado ${(sobra / Math.max(1, cortes.length)).toFixed(2)}s por corte.`,
  );
  return cortes;
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
