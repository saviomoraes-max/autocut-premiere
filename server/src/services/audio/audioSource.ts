// COSTURA DE DISTRIBUIÇÃO (seam #4): isola "como o áudio chega ao backend".
//
//   HOJE (backend local): recebe um caminho de arquivo local (a mídia do clip)
//   e extrai/recorta o áudio com ffmpeg.
//
//   FUTURO (backend hospedado): troca-se SÓ esta função por uma que recebe o
//   áudio já extraído via upload do cliente. Nada mais no pipeline muda — o
//   resto do código só conhece `wavPath`.
import { rm } from "node:fs/promises";
import path from "node:path";
import type { ClipRef } from "../../../../shared/types";
import { concatWavsToWav, extractAudioToWav } from "./extract";

export interface AudioRequest {
  /**
   * Vários clips (track items) a ACHATAR num stream contínuo, em ordem de
   * timeline. Quando presente, tem prioridade sobre `clip`/`audioPath`. Os
   * timestamps voltam em tempo ACHATADO (0 = início do 1º clip) — por isso
   * `sourceOffsetSec` é 0 e o painel mapeia cada corte de volta à origem.
   */
  segments?: ClipRef[];
  /** Clip selecionado na timeline (caminho de mídia local + in/out). Uso local, hoje. */
  clip?: ClipRef;
  /** Atalho: arquivo de áudio/mídia já local (útil pra testes e fora do Premiere). */
  audioPath?: string;
  inSec?: number;
  outSec?: number;
}

export interface ResolvedAudio {
  /** WAV pronto pra transcrição. */
  wavPath: string;
  /**
   * Offset (segundos) a SOMAR aos timestamps da transcrição pra mapeá-los de volta
   * à mídia de origem. É o in point do clip; 0 quando o áudio não foi recortado.
   */
  sourceOffsetSec: number;
  /** Remove o diretório temporário do WAV. */
  cleanup: () => Promise<void>;
}

export async function resolveAudio(req: AudioRequest): Promise<ResolvedAudio> {
  // Caminho ACHATADO: vários clips concatenados num stream contínuo.
  if (req.segments && req.segments.length > 0) {
    return resolveSegments(req.segments);
  }

  const mediaPath = req.clip?.mediaPath ?? req.audioPath;
  if (!mediaPath) {
    throw new Error("Requisição sem mídia: informe `segments`, `clip.mediaPath` ou `audioPath`.");
  }
  const inSec = req.clip?.inSec ?? req.inSec;
  const outSec = req.clip?.outSec ?? req.outSec;

  const wavPath = await extractAudioToWav(mediaPath, { inSec, outSec });
  const dir = path.dirname(wavPath);

  return {
    wavPath,
    sourceOffsetSec: inSec ?? 0,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Extrai o áudio de cada segmento e concatena num único WAV (stream achatado).
 * Os timestamps resultantes ficam em tempo achatado (0 = início do 1º clip);
 * por isso `sourceOffsetSec = 0` — o mapeamento de volta à origem é do painel.
 */
async function resolveSegments(segments: ClipRef[]): Promise<ResolvedAudio> {
  const slicePaths: string[] = [];
  const dirs: string[] = [];
  try {
    for (const seg of segments) {
      const wav = await extractAudioToWav(seg.mediaPath, { inSec: seg.inSec, outSec: seg.outSec });
      slicePaths.push(wav);
      dirs.push(path.dirname(wav));
    }
  } catch (err) {
    // Se um slice falhar, limpa o que já saiu antes de propagar.
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    throw err;
  }

  const wavPath = await concatWavsToWav(slicePaths);
  // concatWavsToWav cria um novo dir quando há >1 slice; rastreia pra limpar.
  if (slicePaths.length > 1) dirs.push(path.dirname(wavPath));

  return {
    wavPath,
    sourceOffsetSec: 0,
    cleanup: () =>
      Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))).then(() => undefined),
  };
}
