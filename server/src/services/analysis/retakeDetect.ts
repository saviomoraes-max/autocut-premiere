// Detecta os SINAIS DE RETAKE que o chefe fala quando vai refazer um take. Aterrado no
// transcript de 2026-06-23: ele anuncia cada retake em voz alta ("vou ler de novo" 4×,
// "vou gravar de novo" 2×, "vou recomeçar", "não gostei"…). O take ANTES do sinal é o ruim;
// o bom é o que vem depois. Isso deixa a escolha de take ser feita por CÓDIGO, das próprias
// palavras do chefe — sem LLM, sem achismo.
//
// Confiança:
//   ALTA  → frase inequívoca de refação ("vou ler/gravar de novo", "vou recomeçar",
//           "não gostei", "errei"). Entra MARCADA.
//   BAIXA → frase ambígua que TAMBÉM aparece em conteúdo ("peraí", "espera aí", "de novo"
//           solto). No transcript real, "peraí" às vezes é conteúdo ("peraí, 40 mil reais
//           de harmonização"). Entra DESMARCADA, só pra revisão.
import type { Word, RetakeSignal } from "../../../../shared/types";

const HIGH: RegExp[] = [
  /vou ler de novo/,
  /vou gravar de novo/,
  /vou (re)?fazer de novo/,
  /vou refazer/,
  /vou recome[cç]ar/,
  /recome[cç]ar (do come[cç]o|de novo|tudo)/,
  /come[cç]ar de novo/,
  /ler de novo/,
  /gravar de novo/,
  /n[aã]o gostei/,
  /\berrei\b/,
];

const LOW: RegExp[] = [
  /\bpera[ií]+\b/,
  /\bpera a[ií]\b/,
  /\bespera a[ií]\b/,
  /\bde novo\b/,
  /\bdeixa eu\b/,
];

function norm(w: string): string {
  return w.trim().toLowerCase().replace(/[.,!?…":;()]/g, "");
}

// Gap (s) entre palavras que QUEBRA a continuidade da frase. Uma frase de retake é dita
// num fôlego (gaps < 0.5s); um buraco maior é pausa/fala separada, e uma frase NÃO pode
// atravessá-lo (senão "vou ler" [30s de pausa] "de novo" casaria "vou ler de novo" e
// mandaria cortar 30s de footage BOM). O separador "¦" não aparece em nenhum padrão.
const BREAK_GAP_SEC = 0.8;
const SEP = " ¦ ";
/** Span máx (s) de uma frase-sinal — defesa extra contra match esticado. */
const MAX_SPAN_SEC = 6;

/** Texto corrido + mapa offset-de-char → índice de palavra, pra casar frases multi-palavra. */
function buildPlain(words: Word[]): { text: string; idxAt: number[] } {
  let text = "";
  const idxAt: number[] = [];
  let prevEnd = -1;
  for (let i = 0; i < words.length; i++) {
    const t = norm(words[i].word);
    if (!t) continue;
    if (text) {
      // Pausa longa desde a última palavra EMITIDA → separador que regex não atravessa.
      const sep = prevEnd >= 0 && words[i].start - prevEnd > BREAK_GAP_SEC ? SEP : " ";
      for (let c = 0; c < sep.length; c++) idxAt.push(i);
      text += sep;
    }
    for (let c = 0; c < t.length; c++) idxAt.push(i);
    text += t;
    prevEnd = words[i].end;
  }
  return { text, idxAt };
}

/**
 * Acha os sinais de retake na transcrição. Casa HIGH primeiro (marcando as palavras já
 * cobertas) e só então LOW fora dessas regiões — assim o "de novo" embutido em "vou ler
 * de novo" não vira um sinal BAIXA duplicado.
 */
export function detectRetakeSignals(words: Word[]): RetakeSignal[] {
  const { text, idxAt } = buildPlain(words);
  const covered = new Array<boolean>(words.length).fill(false);
  const out: RetakeSignal[] = [];

  const scan = (patterns: RegExp[], confidence: "alta" | "baixa") => {
    for (const base of patterns) {
      const re = new RegExp(base.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const wi = idxAt[m.index];
        const wj = idxAt[Math.min(m.index + m[0].length - 1, idxAt.length - 1)];
        if (wi == null || wj == null) continue;
        // Guarda de span: frase esticada demais no tempo não é uma frase real (defesa extra
        // além do separador de pausa) → descarta.
        if (words[wj].end - words[wi].start > MAX_SPAN_SEC) {
          if (m[0].length === 0) re.lastIndex++;
          continue;
        }
        // HIGH manda: se qualquer palavra do match já foi coberta, pula (evita duplicar).
        let overlap = false;
        for (let k = wi; k <= wj; k++) if (covered[k]) overlap = true;
        if (overlap) continue;
        for (let k = wi; k <= wj; k++) covered[k] = true;
        out.push({
          startSec: words[wi].start,
          endSec: words[wj].end,
          phrase: m[0],
          wordIndex: wi,
          confidence,
        });
        if (m[0].length === 0) re.lastIndex++; // guarda anti-loop
      }
    }
  };

  scan(HIGH, "alta");
  scan(LOW, "baixa");

  return out.sort((a, b) => a.startSec - b.startSec);
}
