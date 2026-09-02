// ESTILO CINEMA: transforma o .srt cru (saído do srt.mjs) em legenda de filme.
//
// O srt.mjs compartilhado agrupa palavras em legendas e cuida de tempo/offset/lead, mas emite
// UMA linha só por legenda — ele não sabe quebrar em duas. Como aquele script roda em produção
// no plugin Legendas RECONECTA e no skill vsl-editor, ele NÃO é alterado: a quebra de linha, o
// teto de leitura e o clamp de duração moram aqui dentro do AutoCut (decisão do Sávio, 28/ago).
//
// Os números são do Netflix Timed Text Style Guide, que é o padrão de fato da legendagem:
// no máximo 2 linhas de 42 caracteres, 5/6 de segundo de duração mínima, 7s de máxima e teto
// de 17 caracteres por segundo de leitura.
//   https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617

/** Uma legenda já parseada, com tempo em SEGUNDOS (o texto pode conter "\n" entre 2 linhas). */
export interface Cue {
  startSec: number;
  endSec: number;
  text: string;
}

/** "00:01:23,456" → 83.456 */
function parseTimestamp(ts: string): number {
  const m = ts.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** 83.456 → "00:01:23,456". Decompõe a partir do total em ms (não sofre o arredondamento
 *  que produz ",1000" quando os milissegundos batem no topo). */
function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (v: number, n = 2): string => String(v).padStart(n, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/** Lê o .srt do srt.mjs de volta pra estrutura (índice é recalculado na serialização). */
export function parseSrt(srt: string): Cue[] {
  const cues: Cue[] = [];
  for (const bloco of srt.split(/\r?\n\r?\n/)) {
    const linhas = bloco.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (linhas.length < 2) continue;
    // Bloco = [índice, timestamp, ...texto]. Alguns .srt vêm sem a linha de índice.
    const iTs = linhas.findIndex((l) => l.includes("-->"));
    if (iTs < 0) continue;
    const [de, ate] = linhas[iTs].split("-->");
    const texto = linhas.slice(iTs + 1).join("\n");
    if (!texto) continue;
    cues.push({ startSec: parseTimestamp(de), endSec: parseTimestamp(ate ?? ""), text: texto });
  }
  return cues;
}

/** Volta pro formato .srt, renumerando do 1. */
export function serializeSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.startSec)} --> ${formatTimestamp(c.endSec)}\n${c.text}\n`)
    .join("\n");
}

// Palavras que NÃO devem terminar uma linha: quebrar depois delas separa o artigo/preposição do
// que ele rege e trava a leitura ("…que leva da / avaliação"). Regra do guia de legendagem.
const LIGACAO = new Set([
  "o", "a", "os", "as", "um", "uma", "uns", "umas",
  "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
  "ao", "à", "aos", "às", "pelo", "pela", "pelos", "pelas",
  "por", "para", "pra", "pro", "com", "sem", "sob", "sobre", "entre", "até", "desde",
  "e", "ou", "mas", "que", "se", "como", "quando", "porque", "pois",
  "meu", "minha", "seu", "sua", "nosso", "nossa", "este", "esta", "esse", "essa",
  "aquele", "aquela", "num", "numa", "dum", "duma",
]);

/** Normaliza pra checar se é palavra de ligação (tira pontuação e caixa). */
function base(tok: string): string {
  return tok.toLowerCase().replace(/[.,;:!?…"'"'’“”«»()\[\]{}—–]/g, "");
}

/**
 * Quebra o texto de uma legenda em até `maxLines` linhas de até `maxChars` caracteres.
 *
 * Entre todos os pontos de quebra possíveis (espaços), escolhe o de melhor pontuação:
 *   + quebrar logo DEPOIS de uma pontuação (vírgula, ponto…) é o corte mais natural;
 *   − terminar a linha numa palavra de ligação é penalizado;
 *   − desequilíbrio entre as linhas é penalizado (legenda balanceada lê melhor).
 * Se nenhuma quebra deixar as duas linhas dentro do limite, devolve a mais equilibrada
 * possível — quem chama registra o estouro no log.
 */
export function wrapCue(text: string, maxChars: number, maxLines = 2): string {
  const limpo = text.replace(/\s+/g, " ").trim();
  if (limpo.length <= maxChars || maxLines < 2) return limpo;

  const toks = limpo.split(" ");
  let melhor: { corte: number; nota: number } | null = null;

  for (let corte = 1; corte < toks.length; corte++) {
    const l1 = toks.slice(0, corte).join(" ");
    const l2 = toks.slice(corte).join(" ");
    const cabe = l1.length <= maxChars && l2.length <= maxChars;

    // Nota menor = melhor. Começa pelo desequilíbrio entre as linhas.
    let nota = Math.abs(l1.length - l2.length);
    if (!cabe) nota += 1000 + Math.max(l1.length, l2.length); // só serve como último recurso
    if (/[.,;:!?…]$/.test(l1)) nota -= 12; // quebra depois de pontuação: o corte natural
    if (LIGACAO.has(base(toks[corte - 1]))) nota += 25; // não deixa artigo/preposição órfão

    if (!melhor || nota < melhor.nota) melhor = { corte, nota };
  }

  if (!melhor) return limpo;
  return `${toks.slice(0, melhor.corte).join(" ")}\n${toks.slice(melhor.corte).join(" ")}`;
}

export interface MergeShortOptions {
  /** Abaixo desta duração (s) a legenda é órfã: pisca e não dá tempo de ler. */
  minDur: number;
  /** Duração máxima da legenda resultante da fusão. */
  maxDur: number;
  /** Orçamento de caracteres da legenda (as duas linhas somadas). */
  maxChars: number;
  /** Pausa máxima (s) entre as duas legendas pra ainda valer fundir. */
  maxGapSec: number;
  /** Até este número de palavras a legenda também conta como órfã ("modelo", "entendi"). */
  minWords: number;
}

function contarPalavras(texto: string): number {
  return texto.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Funde as legendas ÓRFÃS na vizinha.
 *
 * O srt.mjs fecha uma legenda toda vez que a fala termina uma frase — o que às vezes deixa
 * uma palavra solta piscando por 0,3s ("modelo", "entendi"). Na legenda dinâmica de reels isso
 * é o efeito desejado; na de cinema é defeito. Aqui a órfã é grudada na vizinha sempre que o
 * resultado ainda couber no orçamento de caracteres, na duração máxima, e as duas estiverem
 * coladas na timeline (uma pausa longa entre elas significa que são falas diferentes mesmo).
 *
 * Passada única da esquerda pra direita: cobre os dois sentidos, porque funde tanto quando a
 * legenda ATUAL é órfã (vai pra anterior) quanto quando a ANTERIOR é órfã (puxa a atual).
 */
export function mergeShortCues(cues: Cue[], o: MergeShortOptions): { cues: Cue[]; fundidas: number } {
  const out: Cue[] = [];
  let fundidas = 0;

  const ehOrfa = (c: Cue): boolean =>
    c.endSec - c.startSec < o.minDur || contarPalavras(c.text) <= o.minWords;

  for (const cue of cues) {
    const ultima = out[out.length - 1];
    if (ultima && (ehOrfa(cue) || ehOrfa(ultima))) {
      const juntos = `${ultima.text} ${cue.text}`.replace(/\s+/g, " ").trim();
      const cabe =
        juntos.length <= o.maxChars &&
        cue.endSec - ultima.startSec <= o.maxDur &&
        cue.startSec - ultima.endSec <= o.maxGapSec;
      if (cabe) {
        ultima.text = juntos;
        ultima.endSec = cue.endSec;
        fundidas++;
        continue;
      }
    }
    out.push({ ...cue });
  }

  return { cues: out, fundidas };
}

export interface ReadingSpeedOptions {
  /** Teto de caracteres por segundo (17 = adulto, no guia da Netflix). */
  cps: number;
  /** Duração mínima de uma legenda (s). */
  minDur: number;
  /** Duração máxima de uma legenda (s). */
  maxDur: number;
  /** Gap mínimo (s) entre o fim de uma legenda e o início da próxima. */
  gapSec: number;
}

/**
 * Ajusta a DURAÇÃO das legendas pra caber na velocidade de leitura.
 *
 * Só mexe no FIM da legenda — o início fica cravado na fala, senão a legenda dessincroniza.
 * Estende até o tempo que a leitura pede, sem passar do máximo nem invadir a próxima legenda
 * (respeitando o gap). Devolve quantas ainda ficaram acima do teto: quando não há espaço na
 * timeline, a legenda simplesmente fica rápida — é honesto reportar em vez de forçar.
 */
export function applyReadingSpeed(
  cues: Cue[],
  opts: ReadingSpeedOptions,
): { cues: Cue[]; acimaDoTeto: number } {
  const out = cues.map((c) => ({ ...c }));
  let acimaDoTeto = 0;

  for (let i = 0; i < out.length; i++) {
    const chars = out[i].text.replace(/\n/g, " ").length;
    const precisa = Math.max(opts.minDur, chars / opts.cps);
    // Teto: o máximo por legenda e, se houver próxima, a fronteira dela menos o gap.
    let limite = out[i].startSec + opts.maxDur;
    if (i < out.length - 1) limite = Math.min(limite, out[i + 1].startSec - opts.gapSec);

    // Nunca encolhe abaixo do fim natural da fala, e nunca passa do limite disponível.
    const alvo = Math.min(out[i].startSec + precisa, Math.max(limite, out[i].endSec));
    out[i].endSec = Math.max(out[i].endSec, alvo);
    // Clamp duro do máximo (uma pausa longa dentro da legenda poderia estourar os 7s).
    if (out[i].endSec - out[i].startSec > opts.maxDur) out[i].endSec = out[i].startSec + opts.maxDur;

    if (chars / (out[i].endSec - out[i].startSec) > opts.cps) acimaDoTeto++;
  }

  return { cues: out, acimaDoTeto };
}
