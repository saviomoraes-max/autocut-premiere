// Funde os cortes de silêncio (acústicos) com os semânticos (Claude):
// clampa ao áudio, descarta minúsculos, ordena e funde sobrepostos/adjacentes.
import type { Cut, CutReason } from "../../../../shared/types";

export interface MergeOptions {
  /** Corte menor que isto (s) é descartado (ruído). */
  minCutSec?: number;
  /** Funde dois cortes se o intervalo entre eles for <= isto (s). */
  mergeGapSec?: number;
}

export function mergeCuts(cuts: Cut[], durationSec: number, opts: MergeOptions = {}): Cut[] {
  const minCut = opts.minCutSec ?? 0.08;
  const gap = opts.mergeGapSec ?? 0.0;
  const limite = durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;

  const limpos = cuts
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(limite, c.end) }))
    .filter((c) => c.end - c.start >= minCut)
    .sort((a, b) => a.start - b.start);

  const fundidos: Cut[] = [];
  for (const c of limpos) {
    const ultimo = fundidos[fundidos.length - 1];
    if (ultimo && c.start <= ultimo.end + gap) {
      // Sobreposição ou encosto: funde no anterior.
      ultimo.end = Math.max(ultimo.end, c.end);
      ultimo.reason = pickReason(ultimo.reason, c.reason);
      ultimo.detail = mergeDetail(ultimo.detail, c.detail);
    } else {
      fundidos.push({ ...c });
    }
  }
  return fundidos;
}

// Ao fundir, prioriza o motivo semântico (mais informativo) sobre "silencio".
function pickReason(a: CutReason, b: CutReason): CutReason {
  if (a === b) return a;
  if (a === "silencio") return b;
  if (b === "silencio") return a;
  return a;
}

function mergeDetail(a?: string, b?: string): string | undefined {
  const partes = [a, b].filter(Boolean) as string[];
  return partes.length ? Array.from(new Set(partes)).join("; ") : undefined;
}
