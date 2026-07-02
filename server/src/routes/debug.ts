// POST /debug — canal de diagnóstico. O painel manda um snapshot do que leu/montou
// e o backend só loga (que dá pra ler no log do servidor). Não afeta o fluxo de corte.
import type { FastifyInstance } from "fastify";
import { log } from "../logger";

export async function debugRoutes(app: FastifyInstance): Promise<void> {
  app.post("/debug", async (req) => {
    const body = req.body as { label?: string; data?: unknown };
    const label = body?.label ?? "debug";
    log.info(`\n=== DEBUG [${label}] ===\n${JSON.stringify(body?.data ?? body, null, 2)}\n=== /DEBUG ===`);
    return { ok: true };
  });
}
