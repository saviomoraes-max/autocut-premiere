// Detecta os MARCADORES falados que o chefe usa pra abrir cada peça no bruto longo.
//
// Vocabulário REAL aterrado no transcript de 2026-06-23 (não é achismo — cada regra abaixo
// tem um hit no áudio): "claquete" (slate de abertura), "lead N"/"lead da <nome>" (ganchos)
// e "corpo N" (corpos). O WhisperX ERRA "lead" pra "lide" e pra "lei de" (duas palavras) —
// ambos tratados aqui. "anúncio"/"reels" ficam no vocabulário pra outros brutos.
//
// O detector NÃO decide sozinho: lista CANDIDATOS com confiança e o humano confirma quais
// são fronteiras de verdade. Modelo de confiança (aterrado nos dados):
//   ALTA  → seguido de NÚMERO ("lead 2", "corpo 1") ou NOME ("lead da Raquel"), OU isolado
//           por uma pausa longa antes (slate puro: "claquete" gap 99s, "corpo 1" gap 11.8s).
//   BAIXA → plural solto na fala corrida ("esses leads tão ruim", "os corpos vão conectar",
//           "esse anúncio") — provável conteúdo, não marcador. Entra DESMARCADO.
// Re-slate (mesmo rótulo repetido logo após, ex.: 2º "Corpo 2" depois de um retake) é
// rebaixado pra BAIXA — o corte de retake já cobre o trecho.
import type { Word, Marker } from "../../../../shared/types";

// Número falado logo após o marcador (dígito ou por extenso) — sinal forte de rótulo.
// Femininos "uma"/"duas" ficam de FORA de propósito: lead/corpo são masculinos ("corpo
// dois"), então "uma"/"duas" depois deles é artigo de fala corrida, não rótulo de bloco.
const DIGIT_RE = /^(\d+|um|dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez)$/i;

function norm(w: string): string {
  return w.trim().toLowerCase().replace(/[.,!?…":;()]/g, "");
}

// Começa com maiúscula no ORIGINAL e não é começo de frase comum → provável nome próprio.
function looksName(raw: string): boolean {
  const t = raw.trim().replace(/[.,!?…":;()]/g, "");
  return /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(t);
}

interface MarkerType {
  /** Casa contra a palavra normalizada. */
  test: (w: string) => boolean;
  /** Rótulo canônico (corrige a grafia do WhisperX: "lide"/"lei de" → "Lead"). */
  canon: string;
  kind: "ad" | "take";
}

const TYPES: MarkerType[] = [
  { test: (w) => /^claquetes?$/.test(w), canon: "Claquete", kind: "ad" },
  { test: (w) => /^leads?$/.test(w) || /^l[ií]des?$/.test(w), canon: "Lead", kind: "take" },
  { test: (w) => /^corpos?$/.test(w), canon: "Corpo", kind: "take" },
  { test: (w) => /^an[uú]ncios?$/.test(w), canon: "Anúncio", kind: "ad" },
  { test: (w) => /^reels?$/.test(w), canon: "Reels", kind: "ad" },
];

export interface MarkerOptions {
  /** Pausa (s) antes da palavra pra contar como "isolada" (slate) → confiança alta. */
  isolationGapSec?: number;
}

/** Acha candidatos a marcador. Quem chama mostra pro humano confirmar antes de fatiar. */
export function detectMarkers(words: Word[], opts: MarkerOptions = {}): Marker[] {
  const gap = opts.isolationGapSec ?? 1.2;
  const out: Marker[] = [];

  for (let i = 0; i < words.length; i++) {
    const cur = norm(words[i].word);
    if (!cur) continue;

    // Acha o tipo. Caso especial "lei de N" (duas palavras) → Lead N.
    let type: MarkerType | undefined;
    let varIdx = i + 1; // de onde ler o sufixo (número/nome)
    if (cur === "lei" && norm(words[i + 1]?.word ?? "") === "de") {
      type = TYPES[1]; // Lead
      varIdx = i + 2;
    } else {
      type = TYPES.find((t) => t.test(cur));
    }
    if (!type) continue;

    // Sufixo do rótulo: SÓ número ("2") ou nome após "da"/"de" ("da Raquel"). Nome SOLTO
    // foi removido de propósito — capturava palavra comum capitalizada no início de frase
    // ("Claquete. Vamos…" virava "Claquete vamos"; "leads. Corpo" virava marcador falso).
    const nextRaw = words[varIdx]?.word ?? "";
    const next = norm(nextRaw);
    let variant = "";
    if (DIGIT_RE.test(next)) {
      variant = next;
    } else if ((next === "da" || next === "de") && looksName(words[varIdx + 1]?.word ?? "")) {
      const nome = norm(words[varIdx + 1].word);
      variant = `${next} ${nome.charAt(0).toUpperCase()}${nome.slice(1)}`;
    }

    const pausaAntes = i === 0 ? 99 : words[i].start - words[i - 1].end;
    const isolated = pausaAntes >= gap;
    // ALTA quando há rótulo forte (número/nome) OU está isolado por pausa (slate puro).
    const confidence: "alta" | "baixa" = variant || isolated ? "alta" : "baixa";

    // Rótulo legível ("Corpo 1", "Lead da Raquel" → capitaliza a 1ª letra).
    let label = (variant ? `${type.canon} ${variant}` : type.canon).trim();
    label = label.charAt(0).toUpperCase() + label.slice(1);

    // OBS: o rebaixamento de RE-SLATE (mesmo rótulo re-clacado após um retake) NÃO é feito
    // aqui — fica em demoteMarkersAfterRetake (shared/blocks.ts), que exige um sinal de
    // retake ENTRE os dois marcadores. Sem essa guarda, dois blocos legítimos de mesmo
    // rótulo gravados próximos seriam rebaixados por engano, escondendo uma fronteira real.

    out.push({
      kind: type.kind,
      label,
      variant: variant || undefined,
      wordIndex: i,
      startSec: words[i].start,
      confidence,
    });
  }

  return out;
}
