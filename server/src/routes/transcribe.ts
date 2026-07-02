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
    }

    const audio = await resolveAudio({
      segments: body.segments,
      clip: body.clip,
      audioPath: body.audioPath,
      inSec: body.inSec,
      outSec: body.outSec,
    });

    // CANCELAMENTO: se o painel fechar a conexão (botão Cancelar), aborta e mata o WhisperX.
    const ac = new AbortController();
    let finalizado = false;
    req.raw.on("close", () => {
      if (!finalizado) {
        log.info("Cliente desconectou — cancelando transcrição.");
        ac.abort();
      }
    });

    try {
      log.info(`Transcrevendo com '${transcriber.name}'...`);
      const transcript = await transcriber.transcribe(audio.wavPath, {
        language,
        prompt: body.prompt,
        signal: ac.signal,
      });
      finalizado = true;
      log.info(
        `OK: ${transcript.words.length} palavras, ${transcript.durationSec.toFixed(1)}s.`,
      );
      // Salva no cache pra os próximos pedidos idênticos (reload do painel, outra ação na
      // mesma sequência) não re-transcreverem.
      writeTranscriptCache(cacheKey, { transcript, sourceOffsetSec: audio.sourceOffsetSec });
      const response: TranscribeResponse = {
        transcript,
        sourceOffsetSec: audio.sourceOffsetSec,
      };
      return response;
    } catch (err) {
      log.error("Falha na transcrição:", err instanceof Error ? err.message : err);
      return reply
        .status(500)
        .send({ error: err instanceof Error ? err.message : "erro desconhecido" });
    } finally {
      await audio.cleanup();
    }
  });
}
