// Análise dos cortes semânticos com o Claude (filler / repetição / bad take).
// Usa structured outputs (output_config.format) para garantir JSON válido,
// combinado com adaptive thinking (recomendado p/ a parte de raciocínio).
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config";
import { log } from "../../logger";
import type { Cut, TranscriptResult } from "../../../../shared/types";
import { SYSTEM_PROMPT, buildUserContent } from "./prompt";
import { cutsJsonSchema, cutsZod } from "./cutSchema";

export interface AnalyzeOptions {
  /** Preferências adicionais do editor (campo opcional do painel). */
  userPrompt?: string;
}

export async function analyzeSemanticCuts(
  transcript: TranscriptResult,
  opts: AnalyzeOptions = {},
): Promise<Cut[]> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY ausente. Defina no server/.env.");
  }
  if (!transcript.words.length) return [];

  // timeout generoso: Opus + effort máximo pode levar vários minutos num transcript longo.
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 20 * 60 * 1000 });
  const userContent = buildUserContent(transcript, opts.userPrompt);

  log.info(
    `Analisando cortes com Claude (${config.anthropic.model}, effort=${config.anthropic.effort})...`,
  );

  // STREAMING obrigatório: com max_tokens/effort altos a request pode passar de 10 min e o
  // SDK recusa requisições não-stream nesse caso. finalMessage() monta a resposta completa.
  const res = await client.messages
    .stream({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      thinking: { type: "adaptive" },
      output_config: {
        effort: config.anthropic.effort,
        format: { type: "json_schema", schema: cutsJsonSchema },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    })
    .finalMessage();

  if (res.stop_reason === "refusal") {
    throw new Error("Claude recusou a análise (stop_reason=refusal).");
  }

  // Com thinking ligado, o bloco de texto (com o JSON) vem depois do bloco de thinking.
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    if (res.stop_reason === "max_tokens") {
      // O thinking (que conta no max_tokens) consumiu o orçamento antes de gerar o JSON.
      throw new Error(
        `Resposta truncada (max_tokens=${config.anthropic.maxTokens}): o thinking do effort máximo gastou todo o orçamento antes do JSON dos cortes. Aumente ANTHROPIC_MAX_TOKENS no server/.env (teto do Opus 4.8 = 128000) ou baixe ANTHROPIC_EFFORT.`,
      );
    }
    throw new Error(`Resposta do Claude sem bloco de texto (stop_reason=${res.stop_reason}).`);
  }

  let payload;
  try {
    payload = cutsZod.parse(JSON.parse(textBlock.text));
  } catch (err) {
    if (res.stop_reason === "max_tokens") {
      throw new Error(
        "JSON truncado (stop_reason=max_tokens). Aumente ANTHROPIC_MAX_TOKENS no server/.env.",
      );
    }
    throw new Error(
      `Falha ao validar o JSON do Claude: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.info(`Claude propôs ${payload.cuts.length} corte(s) semântico(s).`);
  return payload.cuts.map((c) => ({
    start: c.start,
    end: c.end,
    reason: c.reason,
    detail: c.detail,
  }));
}
