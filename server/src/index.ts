// Entrypoint do backend local do AutoCut.
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config";
import { log } from "./logger";
import { healthRoutes } from "./routes/health";
import { transcribeRoutes } from "./routes/transcribe";
import { analyzeRoutes } from "./routes/analyze";
import { srtRoutes } from "./routes/srt";
import { debugRoutes } from "./routes/debug";

async function main(): Promise<void> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });

  // CORS: o painel UXP roda numa origem própria; liberamos pra chamadas locais.
  await app.register(cors, { origin: true });

  // COSTURA DE AUTH (seam #3): em uso local AUTH_TOKEN é vazio e nada é exigido.
  // Hospedando o backend, define-se AUTH_TOKEN e o painel passa Authorization: Bearer <token>.
  app.addHook("onRequest", async (req, reply) => {
    if (!config.authToken) return;
    if (req.headers.authorization !== `Bearer ${config.authToken}`) {
      await reply.status(401).send({ error: "não autorizado" });
    }
  });

  await app.register(healthRoutes);
  await app.register(transcribeRoutes);
  await app.register(analyzeRoutes);
  await app.register(srtRoutes);
  await app.register(debugRoutes);

  await app.listen({ host: config.host, port: config.port });
  log.info(`AutoCut backend ouvindo em http://${config.host}:${config.port}`);
  log.info(`Transcritor ativo: ${config.transcriber} (modelo: ${config.transcriber === "whisperx" ? config.whisperx.model : config.openai.model})`);
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
