// Rota de saúde — o painel usa pra confirmar que o backend está no ar e pra MOSTRAR a
// configuração real (tela Config e etapas da tela Processar), em vez de valor de exemplo.
// Só leitura: nada aqui muda a configuração, que continua vindo do server/.env.
import type { FastifyInstance } from "fastify";
import { config, modeloDoTranscritor } from "../config";

/** Modelo da análise de cortes, conforme o motor ativo. `null` = análise local (sem modelo). */
function modeloDaAnalise(): string | null {
  switch (config.analyzer) {
    case "anthropic":
      return config.anthropic.model;
    case "ollama":
      return config.ollama.model;
    default:
      return null;
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    transcriber: config.transcriber,
    model: modeloDoTranscritor(),
    // Campos acrescentados no redesign do painel (21/09/2026). Painel antigo ignora.
    analyzer: config.analyzer,
    analyzerModel: modeloDaAnalise(),
    analyzerEffort: config.analyzer === "anthropic" ? config.anthropic.effort : null,
    silenceThresholdDb: config.silence.thresholdDb,
  }));
}
