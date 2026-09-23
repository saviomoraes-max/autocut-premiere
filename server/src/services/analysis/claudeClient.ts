// JULGAMENTO DOS RETAKES com o Claude (21/09/2026). Filler e silêncio saem por código; aqui o
// Claude decide o que os detectores não conseguem: se um trecho parecido é REGRAVAÇÃO (corta a
// tentativa velha) ou OUTRA PEÇA do mesmo bruto (não corta). Recebe os candidatos achados por
// código e devolve a lista final, com confiança por corte.
//
// Structured outputs (output_config.format) garante JSON válido; adaptive thinking + effort
// fazem o raciocínio. Streaming é obrigatório com max_tokens alto (o SDK recusa sem ele).
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config";
import { lerChaveDoKeychain } from "../chaveKeychain";
import { log } from "../../logger";
import type { Cut, TranscriptResult } from "../../../../shared/types";
import { SYSTEM_PROMPT, buildUserContent } from "./prompt";
import { cutsJsonSchema, cutsZod } from "./cutSchema";

export interface AnalyzeOptions {
  /** Preferências adicionais do editor (campo opcional do painel). */
  userPrompt?: string;
  /** Candidatos achados por código — o Claude confirma, descarta ou acrescenta. */
  candidatos?: Cut[];
}

/** Preço por milhão de tokens (Claude Opus 5, tabela de 2026-06). Só pra logar o custo real. */
const PRECO = { entrada: 5, saida: 25 } as const;

export async function analyzeSemanticCuts(
  transcript: TranscriptResult,
  opts: AnalyzeOptions = {},
): Promise<Cut[]> {
  // Keychain primeiro (chave fora de arquivo), .env como reserva.
  const apiKey = (await lerChaveDoKeychain(config.anthropic.keychainService)) || config.anthropic.apiKey;
  if (!apiKey) {
    throw new Error(
      `Chave da Anthropic ausente. Guarde no Keychain com: security add-generic-password -s ${config.anthropic.keychainService} -a "$USER" -w  (ou defina ANTHROPIC_API_KEY no server/.env).`,
    );
  }
  if (!transcript.words.length) return [];

  // timeout generoso: Opus + effort máximo pode levar vários minutos num transcript longo.
  const client = new Anthropic({ apiKey, timeout: 20 * 60 * 1000 });
  const userContent = buildUserContent(transcript, opts.userPrompt, opts.candidatos ?? []);

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

  // Saldo zerado é o erro mais comum aqui (aconteceu em 22/09) — a mensagem da API já explica,
  // e quem chama (analyze.ts) segue com os candidatos do código.
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

  const u = res.usage;
  const custo = (u.input_tokens / 1e6) * PRECO.entrada + (u.output_tokens / 1e6) * PRECO.saida;
  const altas = payload.cuts.filter((c) => c.confidence === "alta").length;
  log.info(
    `Claude: ${payload.cuts.length} corte(s) de retake (${altas} com confiança alta) · ` +
      `${u.input_tokens} tokens de entrada + ${u.output_tokens} de saída ≈ US$ ${custo.toFixed(3)}.`,
  );
  return payload.cuts.map((c) => ({
    start: c.start,
    end: c.end,
    reason: c.reason,
    detail: `${c.detail} [IA]`,
    // confiança baixa entra DESMARCADA no painel (mesmo campo do detector de trecho refeito)
    review: c.confidence === "baixa" || undefined,
  }));
}
