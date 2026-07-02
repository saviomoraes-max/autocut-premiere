// Análise dos cortes semânticos com um LLM LOCAL (Ollama) — sem custo de API.
// Reusa o MESMO system prompt e o MESMO JSON schema da via Anthropic; só troca o motor.
// Forma da API confirmada na doc oficial do Ollama (https://docs.ollama.com/capabilities/
// structured-outputs): POST /api/chat com "format" = JSON schema; resposta em message.content.
import { config } from "../../config";
import { log } from "../../logger";
import type { Cut, TranscriptResult } from "../../../../shared/types";
import { SYSTEM_PROMPT, buildUserContent } from "./prompt";
import { cutsJsonSchema, cutsZod } from "./cutSchema";
import type { AnalyzeOptions } from "./claudeClient";

// Few-shot: ancora o modelo pequeno em FRONTEIRA exata + label certo (7B erra isso sem
// exemplo). É específico do motor local — não toca a via Anthropic, que já vai bem sem.
const FEWSHOT_USER = `Transcrição palavra a palavra (índice\tinício-fim\tpalavra):
0\t0.00-0.30\tentão
1\t0.40-0.70\tééé
2\t0.80-0.95\to
3\t1.00-1.15\to
4\t1.20-1.35\to
5\t1.45-1.85\tresultado

Retorne os trechos a remover no formato pedido.`;
const FEWSHOT_ASSISTANT = JSON.stringify({
  cuts: [
    { start: 0.4, end: 0.7, reason: "filler", detail: "muleta 'ééé'" },
    { start: 0.8, end: 1.15, reason: "filler", detail: "gagueira 'o o', mantida uma" },
  ],
});

export async function analyzeSemanticCutsOllama(
  transcript: TranscriptResult,
  opts: AnalyzeOptions = {},
): Promise<Cut[]> {
  if (!transcript.words.length) return [];

  const userContent = buildUserContent(transcript, opts.userPrompt);
  const url = `${config.ollama.baseUrl}/api/chat`;

  log.info(
    `Analisando cortes com Ollama local (${config.ollama.model}, num_ctx=${config.ollama.numCtx})...`,
  );

  let res: Response;
  try {
    // timeout generoso: 7B local num transcript médio pode levar minutos.
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20 * 60 * 1000),
      body: JSON.stringify({
        model: config.ollama.model,
        stream: false,
        format: cutsJsonSchema, // structured outputs: força o JSON no schema dos cortes
        options: { temperature: 0, num_ctx: config.ollama.numCtx }, // temp 0 = determinístico (dica oficial)
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          // Exemplo resolvido (few-shot) pra firmar fronteira/label num modelo pequeno.
          { role: "user", content: FEWSHOT_USER },
          { role: "assistant", content: FEWSHOT_ASSISTANT },
          // Reforço recomendado pela doc do Ollama: pedir o JSON explicitamente.
          {
            role: "user",
            content: `${userContent}\n\nResponda SOMENTE com o JSON no formato pedido, sem texto fora dele.`,
          },
        ],
      }),
    });
  } catch (err) {
    throw new Error(
      `Não consegui falar com o Ollama em ${url}. Ele está rodando? (rode: ollama serve). ` +
        `Erro: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama respondeu ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (!content) throw new Error("Ollama não devolveu conteúdo (message.content vazio).");

  let payload;
  try {
    payload = cutsZod.parse(JSON.parse(content));
  } catch (err) {
    throw new Error(
      `JSON inválido do Ollama (${err instanceof Error ? err.message : String(err)}). ` +
        `Conteúdo: ${content.slice(0, 300)}`,
    );
  }

  log.info(`Ollama propôs ${payload.cuts.length} corte(s) semântico(s).`);
  return payload.cuts.map((c) => ({ start: c.start, end: c.end, reason: c.reason, detail: c.detail }));
}
