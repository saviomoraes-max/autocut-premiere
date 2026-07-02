// Auto-Zoom: acha "pontas de interesse" na transcrição e propõe um gesto de zoom no efeito
// Transformar (escala 100 → até 110 → 100), keyframado. Determinístico, por CÓDIGO — sem LLM,
// sem custo. Gatilhos aterrados (cada um é defensável, não é achismo de prosódia):
//   • NÚMERO/VALOR  → punch rápido e forte (o que a RECONECTA mais enfatiza: resultado, R$).
//   • IDEIA NOVA    → push lento, no começo de uma frase depois de uma pausa.
//   • PERGUNTA      → push lento ao longo da pergunta (sobe a tensão).
// O humano revê e marca/desmarca cada gesto antes de aplicar.
import type { Word, ZoomKey, ZoomPoint } from "../../../../shared/types";

export interface ZoomOptions {
  /** Teto da escala (nunca passa disto). Default 110. */
  maxScale?: number;
  /** Pico do punch (número). Default 110. */
  punchScale?: number;
  /** Pico do push (ideia/pergunta). Default 105. */
  pushScale?: number;
  /** Distância mínima entre os CENTROS de dois gestos (s). Default 3.5. */
  minGapSec?: number;
  /** Pausa (s) que caracteriza "ideia nova" no começo de frase. Default 0.8. */
  ideaPauseSec?: number;
}

// Token com número (dígito) ou palavra de valor/quantidade — sinal forte de ênfase.
const NUMERO_RE = /\d/;
const VALOR_RE = /^(mil|milh[aã]o|milh[oõ]es|reais|real|r\$|por\s?cento|vezes)$/i;

function norm(w: string): string {
  return w.trim().toLowerCase().replace(/[.,!?…":;()]/g, "");
}
function endsSentence(w: string): boolean {
  return /[.!?…]$/.test(w.trim());
}
function isQuestionEnd(w: string): boolean {
  return /\?$/.test(w.trim());
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Shape PUNCH: entra rápido até `peak`, segura um tiquinho, sai pra 100 (zoom in e out). */
function punchKeys(centerSec: number, peak: number): ZoomKey[] {
  const c = Math.max(0, centerSec);
  return [
    { atSec: Math.max(0, c - 0.12), scale: 100, ease: "bezier" },
    { atSec: c + 0.2, scale: peak, ease: "bezier" },
    { atSec: c + 0.55, scale: peak, ease: "bezier" },
    { atSec: c + 0.9, scale: 100, ease: "bezier" },
  ];
}

/** Shape PUSH: sobe devagar até `peak` ao longo da frase e volta suave pra 100. */
function pushKeys(startSec: number, endSec: number, peak: number): ZoomKey[] {
  const a = Math.max(0, startSec);
  const dur = clamp(endSec - startSec, 1.8, 3.5);
  return [
    { atSec: a, scale: 100, ease: "bezier" },
    { atSec: a + dur * 0.62, scale: peak, ease: "bezier" },
    { atSec: a + dur, scale: 100, ease: "bezier" },
  ];
}

const PRIORIDADE: Record<ZoomPoint["trigger"], number> = { numero: 3, pergunta: 2, ideia: 1 };

/** Acha os pontos de zoom na transcrição. Devolve gestos já com keyframes (tempo achatado). */
export function detectZoomPoints(words: Word[], opts: ZoomOptions = {}): ZoomPoint[] {
  const maxScale = opts.maxScale ?? 110;
  const punchScale = Math.min(maxScale, opts.punchScale ?? 110);
  const pushScale = Math.min(maxScale, opts.pushScale ?? 105);
  const minGap = opts.minGapSec ?? 4.5;
  const ideaPause = opts.ideaPauseSec ?? 0.8;

  const bruto: ZoomPoint[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const t = norm(w.word);
    if (!t) continue;
    const center = (w.start + w.end) / 2;

    // 1) NÚMERO / VALOR → punch.
    if (NUMERO_RE.test(t) || VALOR_RE.test(t)) {
      bruto.push({
        trigger: "numero",
        style: "punch",
        word: w.word.trim(),
        startSec: w.start,
        endSec: w.end + 0.9,
        keys: punchKeys(center, punchScale),
        wordIndex: i,
        confidence: "alta",
      });
      continue;
    }

    // Começo de frase = a palavra anterior terminou uma frase (ou é a 1ª palavra).
    const novaFrase = i === 0 || endsSentence(words[i - 1].word);
    const pausaAntes = i === 0 ? 99 : w.start - words[i - 1].end;

    // 2) PERGUNTA → push ao longo da frase que termina em "?".
    //    Detecta no começo da frase olhando à frente até achar o "?".
    if (novaFrase) {
      let fim = -1;
      for (let j = i; j < words.length && j < i + 40; j++) {
        if (isQuestionEnd(words[j].word)) {
          fim = j;
          break;
        }
        if (j > i && endsSentence(words[j].word)) break; // acabou a frase sem "?"
      }
      if (fim >= 0) {
        bruto.push({
          trigger: "pergunta",
          style: "push",
          word: words.slice(i, Math.min(fim + 1, i + 8)).map((x) => x.word).join(" ").trim(),
          startSec: w.start,
          endSec: words[fim].end,
          keys: pushKeys(w.start, words[fim].end, pushScale),
          wordIndex: i,
          confidence: "alta",
        });
        continue;
      }

      // 3) IDEIA NOVA → push, quando a frase começa depois de uma pausa.
      if (pausaAntes >= ideaPause) {
        const fimFrase = Math.min(words.length - 1, i + 6);
        bruto.push({
          trigger: "ideia",
          style: "push",
          word: words.slice(i, i + 5).map((x) => x.word).join(" ").trim(),
          startSec: w.start,
          endSec: words[fimFrase].end,
          keys: pushKeys(w.start, w.start + 2.6, pushScale),
          wordIndex: i,
          // "Ideia nova após pausa" é sinal FRACO e frequente (dispara em quase toda frase).
          // Entra sempre DESMARCADO (opt-in) — quem carrega o default são número e pergunta,
          // que têm impacto de verdade. O editor adiciona os pushes onde quiser.
          confidence: "baixa",
        });
      }
    }
  }

  // DEDUP por distância mínima entre centros — mantém o de maior prioridade (número > pergunta > ideia).
  const comCentro = bruto
    .map((p) => ({ p, c: (p.startSec + p.endSec) / 2 }))
    .sort((a, b) => a.c - b.c);
  const mantidos: Array<{ p: ZoomPoint; c: number }> = [];
  for (const cur of comCentro) {
    const last = mantidos[mantidos.length - 1];
    if (last && cur.c - last.c < minGap) {
      // Conflito: fica o de maior prioridade (empate → o que já estava).
      if (PRIORIDADE[cur.p.trigger] > PRIORIDADE[last.p.trigger]) mantidos[mantidos.length - 1] = cur;
    } else {
      mantidos.push(cur);
    }
  }

  return mantidos.map((m) => m.p);
}
