// Detecta CLAQUETES-NÚMERO: o chefe grava N versões de um MESMO início e numera cada uma com
// uma palavra-código ARBITRÁRIA + número — não um vocabulário fixo. Aterrado no bruto SEM27
// (Juliana): ele anuncia "a gente vai para os SETE RUCs diferentes" e cracha cada take:
//   "RUC 1" · "RUC2" (colado) · "Cook 3" · "Hulk 4" · "Hulk 6" · "Hulk 7"  + retake "o 6".
// Como a palavra-código muda (RUC/Hulk/Cook), o sinal genérico é o NÚMERO 1–9 usado como slate:
//   forma COLADA  (CODE+dígito: RUC2, Hulk1),
//   CÓDIGO+número (palavra Capitalizada/CAIXA-ALTA não-comum + número: "Cook 3"),
//   ARTIGO+número ("o 6" — referência de retake, confiança baixa).
// Exclui conteúdo ("200 mil", "3 anos") e as palavras de marcador de ANÚNCIO (que o detectMarkers
// já trata). Validado no bruto real: pega 6 dos 7 RUCs + retakes, zero falso-positivo. O 7º RUC
// (sem número falado) fica pro humano marcar OU pra futura detecção por reinício de conteúdo.
//
// NÃO decide sozinho: devolve CANDIDATOS "take" com confiança; o painel mostra pro humano
// confirmar quais viram fronteira de sequência.
import type { Word, Marker } from "../../../../shared/types";

const SPELLED: Record<string, number> = {
  um: 1, dois: 2, tres: 3, três: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
};
// Unidades que denunciam CONTEÚDO logo após o número ("200 mil", "3 anos") — não é claquete.
const CONTENT = new Set([
  "mil", "reais", "real", "anos", "ano", "meses", "mes", "mês", "horas", "hora", "minutos",
  "dias", "dia", "pontos", "porcento",
]);
// Palavras comuns (início de frase capitalizado) + os marcadores de ANÚNCIO (tratados à parte)
// — NÃO são palavras-código de take.
const NOT_CODE = new Set([
  "o", "a", "os", "as", "e", "mas", "que", "nao", "não", "um", "uma", "de", "da", "do", "no",
  "na", "em", "pra", "para", "com", "por", "se", "tu", "eu", "ela", "ele", "isso", "aqui",
  "agora", "ja", "já", "vamos", "deixa", "anota", "perai", "peraí", "entao", "então", "olha",
  "tipo", "anuncio", "anúncio", "anuncios", "claquete", "lead", "lide", "corpo", "corpos", "reels",
]);

function norm(x: string): string {
  return x.toLowerCase().replace(/[^a-z0-9à-ÿ]/gi, "");
}

/** Número 1–9 (dígito ou por extenso), ou null. */
function toNum(raw: string): number | null {
  const t = raw.replace(/[.,!?…:;()]/g, "").toLowerCase();
  if (/^[1-9]$/.test(t)) return Number(t);
  return SPELLED[norm(t)] ?? null;
}

/** Palavra-código = Capitalizada OU CAIXA-ALTA (≥2), não-comum e não marcador de anúncio. */
function isCode(raw: string): boolean {
  const r = raw.replace(/[.,!?…:;()]/g, "");
  if (!r || NOT_CODE.has(norm(r))) return false;
  return /^[A-ZÀ-Ý]{2,}$/.test(r) || /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(r);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Acha as claquetes-número (take slates). Quem chama mostra pro humano confirmar. */
export function detectCodeSlates(words: Word[]): Marker[] {
  const out: Marker[] = [];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i].word.trim();

    // 1) COLADO: CODE+dígito (RUC2, Hulk1) — uma palavra só.
    const glued = raw.match(/^([A-ZÀ-Ý]{2,}|[A-ZÀ-Ý][a-zà-ÿ]+)([1-9])[.,]?$/);
    if (glued && !NOT_CODE.has(norm(glued[1]))) {
      out.push({
        kind: "take",
        label: cap(`${glued[1]} ${glued[2]}`),
        variant: glued[2],
        wordIndex: i,
        startSec: words[i].start,
        confidence: "alta",
      });
      continue;
    }

    // 2) e 3): número solto precedido de código ("Cook 3") ou artigo ("o 6").
    const num = toNum(raw);
    if (num == null || num > 9) continue;
    const after = norm(words[i + 1]?.word ?? "");
    if (CONTENT.has(after)) continue; // "200 mil", "3 anos" — conteúdo, não claquete
    const prevRaw = (words[i - 1]?.word ?? "").replace(/[.,!?…:;()]/g, "");
    const prevN = norm(prevRaw);

    if (isCode(prevRaw)) {
      out.push({
        kind: "take",
        label: cap(`${prevRaw} ${num}`),
        variant: String(num),
        wordIndex: i - 1,
        startSec: words[i - 1].start,
        confidence: "alta",
      });
    } else if (prevN === "o" || prevN === "do" || prevN === "ao") {
      // "o 6" / "gravar de novo o 6" — referência de retake; baixa (entra desmarcado).
      out.push({
        kind: "take",
        label: cap(`${prevRaw} ${num}`),
        variant: String(num),
        wordIndex: i,
        startSec: words[i].start,
        confidence: "baixa",
      });
    }
  }
  return out;
}
