// Rota de saúde — o painel usa pra confirmar que o backend está no ar.
import type { FastifyInstance } from "fastify";
import { config, modeloDoTranscritor } from "../config";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    transcriber: config.transcriber,
    model: modeloDoTranscritor(),
  }));
}
