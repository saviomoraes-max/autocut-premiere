// FEATURE "pausa longa = fronteira": uma pausa MUITO longa no meio da fala quase sempre é o
// Léo parando pra reorganizar / recomeçar um take. Serve de fronteira de bloco/take — um sinal
// a MAIS além do silêncio comum (que só corta o vazio). O marcador cai onde a fala RECOMEÇA.
//
// Aterrado no bruto real (2026-07-01): pausas de 42,3s @ 9:56, 12,9s @ 5:11, 9,4s @ 8:48,
// 8,0s @ 4:28 — todas seguidas de um recomeço.
//
// Entra como Marker kind "take" confidence "baixa" (DESMARCADO) — o humano decide se vira
// fronteira de sequência. Reaproveita a seção de segmentação do painel; não inventa UI.
import type { Marker, Word } from "../../../../shared/types";

export interface PauseBoundaryOptions {
  /** Pausa (s) a partir da qual vira fronteira candidata. */
  minPauseSec?: number;
}

/** Acha as pausas longas e devolve marcadores de fronteira (na palavra que retoma a fala). */
export function detectPauseBoundaries(words: Word[], opts: PauseBoundaryOptions = {}): Marker[] {
  const minPause = opts.minPauseSec ?? 8;
  const out: Marker[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap < minPause) continue;
    out.push({
      kind: "take",
      label: `Pausa ${Math.round(gap)}s`,
      variant: undefined,
      wordIndex: i,
      startSec: words[i].start,
      confidence: "baixa", // sempre pra revisão — pausa não é fronteira garantida
    });
  }
  return out;
}
