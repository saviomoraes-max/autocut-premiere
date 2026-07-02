// POST /srt — recebe as palavras transcritas (word-level) e devolve o .srt no padrão do
// plugin Legendas RECONECTA (preset Create Captions + dinheiro/nomes). NÃO escreve em disco
// do usuário; quem salva é o painel (seletor de arquivo do UXP).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { log } from "../logger";
import { buildSrtLegendas } from "../services/srt/buildSrt";

const wordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  score: z.number().optional(),
});

const bodySchema = z.object({
  words: z.array(wordSchema).min(1),
  /** Segundos somados a cada legenda (posição/timecode na sequência). */
  offsetSec: z.number().optional(),
  /** Adianta todas as legendas em N s (sincronia fina). */
  leadSec: z.number().optional(),
});

export interface SrtResponse {
  srt: string;
  count: number;
}

export async function srtRoutes(app: FastifyInstance): Promise<void> {
  app.post("/srt", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { words, offsetSec, leadSec } = parsed.data;
    try {
      const { srt, count } = await buildSrtLegendas(words, { offsetSec, leadSec });
      const res: SrtResponse = { srt, count };
      return res;
    } catch (err) {
      log.error("Falha ao gerar SRT:", err instanceof Error ? err.message : err);
      return reply
        .status(500)
        .send({ error: err instanceof Error ? err.message : "erro desconhecido" });
    }
  });
}
