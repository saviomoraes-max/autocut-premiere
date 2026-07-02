// Lógica pura (sem dependências) do Auto-Zoom: mapeia os keyframes de um gesto de zoom
// (em tempo ACHATADO) para o clip da V1 que os contém + o tempo RELATIVO ao começo do clip.
// O efeito Transformar é aplicado por clip (opção B), então cada gesto precisa cair dentro
// de um único clip — se um gesto cruzar a fronteira, é grampeado ao clip do seu centro.
import type { LaidSegment } from "./segments";
import type { ZoomKey, ZoomPoint } from "./types";

/** Um keyframe já resolvido pro clip de destino: tempo relativo ao começo do clip (s). */
export interface ClipZoomKey {
  relSec: number;
  scale: number;
  ease: ZoomKey["ease"];
}

/** Os keyframes de zoom de UM clip (segmento) da V1. */
export interface ClipZoom {
  segmentIndex: number;
  keys: ClipZoomKey[];
  /** Rótulos dos gestos que caíram nesse clip (diagnóstico/UI). */
  labels: string[];
}

/** O segmento (achatado) que contém um instante; null se cair num gap. */
function segmentAt(atSec: number, laid: ReadonlyArray<LaidSegment>): LaidSegment | null {
  for (const seg of laid) {
    if (atSec >= seg.flatStart && atSec < seg.flatEnd) return seg;
  }
  // Borda direita do último segmento (atSec == flatEnd) cai no último.
  const last = laid[laid.length - 1];
  if (last && atSec >= last.flatStart && atSec <= last.flatEnd) return last;
  return null;
}

/**
 * Agrupa os keyframes de todos os gestos por clip da V1. Cada gesto é atribuído ao clip do
 * seu CENTRO; os keyframes são grampeados ao span desse clip (pra não vazar pro vizinho) e
 * convertidos pra tempo relativo ao começo do clip. Gestos sem clip (gap) são ignorados.
 */
export function mapZoomKeysToClips(
  points: ReadonlyArray<ZoomPoint>,
  laid: ReadonlyArray<LaidSegment>,
): ClipZoom[] {
  const porClip = new Map<number, ClipZoom>();

  for (const p of points) {
    const centro = (p.startSec + p.endSec) / 2;
    const seg = segmentAt(centro, laid);
    if (!seg) continue;

    const bucket = porClip.get(seg.index) ?? { segmentIndex: seg.index, keys: [], labels: [] };
    bucket.labels.push(`${p.style}:${p.word}`);
    for (const k of p.keys) {
      // Grampeia ao clip e converte pra relativo ao começo do clip.
      const at = Math.min(seg.flatEnd, Math.max(seg.flatStart, k.atSec));
      bucket.keys.push({ relSec: at - seg.flatStart, scale: k.scale, ease: k.ease });
    }
    porClip.set(seg.index, bucket);
  }

  // Ordena os keyframes de cada clip por tempo e funde duplicados exatos (mesma posição).
  const out: ClipZoom[] = [];
  for (const cz of porClip.values()) {
    cz.keys.sort((a, b) => a.relSec - b.relSec);
    const dedup: ClipZoomKey[] = [];
    for (const k of cz.keys) {
      const prev = dedup[dedup.length - 1];
      if (prev && Math.abs(prev.relSec - k.relSec) < 1e-4) prev.scale = k.scale; // mesma posição: vence o último
      else dedup.push(k);
    }
    cz.keys = dedup;
    out.push(cz);
  }
  return out.sort((a, b) => a.segmentIndex - b.segmentIndex);
}

/** Soma total dos gestos habilitados (pra resumo da UI). */
export function summarizeZooms(points: ReadonlyArray<ZoomPoint>): {
  total: number;
  punch: number;
  push: number;
} {
  let punch = 0;
  let push = 0;
  for (const p of points) {
    if (p.style === "punch") punch++;
    else push++;
  }
  return { total: points.length, punch, push };
}
