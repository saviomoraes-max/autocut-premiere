// Schema dos cortes semânticos que o Claude classifica.
// Silêncio NÃO entra aqui — é detectado acusticamente (silenceDetect.ts).
import { z } from "zod";

// Categorias que o Claude pode atribuir.
export const SEMANTIC_REASONS = ["filler", "repeticao", "bad_take"] as const;

// JSON Schema enviado à API via output_config.format (structured outputs).
// Structured outputs exige additionalProperties:false em todo objeto.
export const cutsJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cuts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          start: { type: "number", description: "Início do trecho a remover, em segundos (igual ao start de uma palavra da transcrição)." },
          end: { type: "number", description: "Fim do trecho a remover, em segundos (igual ao end de uma palavra da transcrição)." },
          reason: { type: "string", enum: [...SEMANTIC_REASONS] },
          detail: { type: "string", description: "Explicação curta em pt-BR do porquê do corte." },
          confidence: {
            type: "string",
            enum: ["alta", "baixa"],
            description: "alta = certeza (entra marcado no painel); baixa = plausível, decisão do editor (entra desmarcado).",
          },
        },
        required: ["start", "end", "reason", "detail", "confidence"],
      },
    },
  },
  required: ["cuts"],
} as const;

// Validação client-side da resposta (defesa em profundidade, mesmo com structured outputs).
export const cutsZod = z.object({
  cuts: z.array(
    z.object({
      start: z.number().nonnegative(),
      end: z.number().positive(),
      reason: z.enum(SEMANTIC_REASONS),
      detail: z.string(),
      confidence: z.enum(["alta", "baixa"]),
    }),
  ),
});

export type CutsPayload = z.infer<typeof cutsZod>;
