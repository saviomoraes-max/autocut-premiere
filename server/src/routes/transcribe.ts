// POST /transcribe
// Recebe ou um `clip` (mídia local + in/out, vindo do painel) ou um `audioPath`
// (atalho de teste), extrai o áudio e devolve a transcrição word-level.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { log } from "../logger";
import { resolveAudio } from "../services/audio/audioSource";
import { makeTranscriber } from "../services/transcription";
import {
  readTranscriptCache,
  transcriptCacheKey,
  writeTranscriptCache,
} from "../services/transcription/cache";
import type { TranscriptResult } from "../../../shared/types";

const clipSchema = z.object({
  mediaPath: z.string().min(1),
  inSec: z.number().nonnegative(),
  outSec: z.number().positive(),
  fps: z.number().positive(),
});

const bodySchema = z
  .object({
    // Vários clips achatados num stream contínuo (modo seleção/sequência).
    segments: z.array(clipSchema).min(1).optional(),
    clip: clipSchema.optional(),
    audioPath: z.string().min(1).optional(),
    inSec: z.number().nonnegative().optional(),
    outSec: z.number().positive().optional(),
    language: z.string().optional(),
    prompt: z.string().optional(),
    // Força re-transcrição ignorando o cache (default: usa o cache se houver).
    refresh: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.segments?.length || b.clip || b.audioPath), {
    message: "Informe `segments`, `clip` ou `audioPath`.",
  });

export interface TranscribeResponse {
  transcript: TranscriptResult;
  /** Offset (s) a somar aos timestamps pra mapear de volta à mídia de origem. */
  sourceOffsetSec: number;
}

/**
 * SINGLE-FLIGHT: uma transcrição EM ANDAMENTO por chave de cache. Se chegar um pedido idêntico
 * (clique repetido, painel recarregado), ele PEGA CARONA na que já roda em vez de disparar outro
 * WhisperX — dois em paralelo dividiam a CPU e deixavam os DOIS ~2× mais lentos (visto no log:
 * duas execuções idênticas simultâneas). Só cancela o WhisperX quando TODOS os interessados
 * desconectam (contagem de ouvintes).
 */
interface Flight {
  key: string;
  promise: Promise<TranscribeResponse>;
  ac: AbortController;
  ouvintes: number;
  done: boolean;
}
const emVoo = new Map<string, Flight>();

/** Amarra o cancelamento do request ao voo: só aborta quando o ÚLTIMO ouvinte desconecta. */
function assinarVoo(raw: { on: (ev: string, fn: () => void) => void }, flight: Flight): void {
  flight.ouvintes++;
  raw.on("close", () => {
    if (flight.done) return; // close por resposta enviada, não por cancelamento
    flight.ouvintes--;
    if (flight.ouvintes <= 0) {
      log.info("Todos os clientes desconectaram — cancelando transcrição.");
      // Sai do mapa NA HORA (não quando a promise rejeitar): o painel aborta o request velho e
      // dispara o novo em milissegundos — se o voo morto ficasse no mapa, o request novo pegava
      // carona nele e herdava o "Transcrição cancelada" (500 sem ninguém ter cancelado).
      if (emVoo.get(flight.key) === flight) emVoo.delete(flight.key);
      flight.ac.abort();
    }
  });
}

export async function transcribeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/transcribe", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const body = parsed.data;

    // CACHE: assinatura da mídia pedida (engine + idioma + prompt + arquivos/in-out). Se houver
    // transcrição salva pra ESTA mesma entrada, devolve do disco — sem ffmpeg, sem WhisperX.
    const transcriber = makeTranscriber();
    const language = body.language ?? config.language;
    const parts = body.segments?.length
      ? body.segments.map((s) => ({ mediaPath: s.mediaPath, inSec: s.inSec, outSec: s.outSec }))
      : body.clip
        ? [{ mediaPath: body.clip.mediaPath, inSec: body.clip.inSec, outSec: body.clip.outSec }]
        : [{ mediaPath: body.audioPath as string, inSec: body.inSec, outSec: body.outSec }];
    // Params do transcritor entram na chave: mudar a config (ex.: condition_on_previous_text)
    // invalida o cache e força re-transcrição — senão o transcript bugado voltaria do disco.
    const engineConfig =
      transcriber.name === "whisperx"
        ? {
            model: config.whisperx.model,
            alignModel: config.whisperx.alignModel,
            conditionPrev: config.whisperx.conditionOnPreviousText,
            initialPrompt: config.whisperx.initialPrompt,
          }
        : { model: config.openai.model };
    const cacheKey = transcriptCacheKey({ engine: transcriber.name, language, prompt: body.prompt, engineConfig, parts });

    if (!body.refresh) {
      const cached = readTranscriptCache(cacheKey);
      if (cached) {
        log.info(
          `Cache HIT — transcrição salva (${cached.transcript.words.length} palavras), sem re-transcrever.`,
        );
        const response: TranscribeResponse = {
          transcript: cached.transcript,
          sourceOffsetSec: cached.sourceOffsetSec,
        };
        return response;
      }
      // SINGLE-FLIGHT: pedido idêntico já em andamento → pega carona, sem 2º WhisperX.
      // Voo já abortado NÃO aceita carona (o novo pedido vira dono de um voo limpo).
      const vivo = emVoo.get(cacheKey);
      if (vivo && !vivo.ac.signal.aborted) {
        log.info("Transcrição idêntica já em andamento — pegando carona (sem 2º WhisperX).");
        assinarVoo(req.raw, vivo);
        try {
          return await vivo.promise;
        } catch (err) {
          return reply
            .status(500)
            .send({ error: err instanceof Error ? err.message : "erro desconhecido" });
        }
      }
    }

    // DONO do voo: roda a transcrição de verdade; caronas aguardam esta promise.
    const ac = new AbortController();
    const flight: Flight = { key: cacheKey, ac, ouvintes: 0, done: false, promise: undefined as never };
    flight.promise = (async (): Promise<TranscribeResponse> => {
      const audio = await resolveAudio({
        segments: body.segments,
        clip: body.clip,
        audioPath: body.audioPath,
        inSec: body.inSec,
        outSec: body.outSec,
      });
      try {
        log.info(`Transcrevendo com '${transcriber.name}'...`);
        const transcript = await transcriber.transcribe(audio.wavPath, {
          language,
          prompt: body.prompt,
          signal: ac.signal,
        });
        flight.done = true;
        log.info(`OK: ${transcript.words.length} palavras, ${transcript.durationSec.toFixed(1)}s.`);
        // Salva no cache pra os próximos pedidos idênticos (reload do painel, outra ação na
        // mesma sequência) não re-transcreverem.
        writeTranscriptCache(cacheKey, { transcript, sourceOffsetSec: audio.sourceOffsetSec });
        return { transcript, sourceOffsetSec: audio.sourceOffsetSec };
      } finally {
        flight.done = true;
        await audio.cleanup();
      }
    })();
    emVoo.set(cacheKey, flight);
    // Limpa o voo ao terminar (o catch vazio evita unhandled rejection — o erro real é
    // tratado nos awaits de dono/caronas). Só remove se a chave ainda apontar pra ESTE voo
    // (um dono novo pode ter sobrescrito depois de um abort).
    flight.promise
      .catch(() => undefined)
      .finally(() => {
        if (emVoo.get(cacheKey) === flight) emVoo.delete(cacheKey);
      });
    assinarVoo(req.raw, flight);

    try {
      return await flight.promise;
    } catch (err) {
      log.error("Falha na transcrição:", err instanceof Error ? err.message : err);
      return reply
        .status(500)
        .send({ error: err instanceof Error ? err.message : "erro desconhecido" });
    }
  });
}
