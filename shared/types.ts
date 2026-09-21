// Contrato compartilhado entre o painel (UXP) e o backend (Node).
// Mantido em um único lugar pra painel e servidor nunca divergirem de tipo.

/** Uma palavra transcrita, com timestamps EM SEGUNDOS relativos ao áudio transcrito. */
export interface Word {
  word: string;
  start: number; // segundos
  end: number; // segundos
  /** Confiança do alinhamento (0..1) — disponível no WhisperX, ausente no OpenAI e no ElevenLabs. */
  score?: number;
}

/** Resultado completo de uma transcrição. */
export interface TranscriptResult {
  words: Word[];
  /** Texto corrido (útil pra mandar ao Claude e pra revisão humana). */
  text: string;
  /** Idioma detectado/usado, ex: "pt". */
  language: string;
  /** Duração do áudio transcrito, em segundos. */
  durationSec: number;
  /** Qual motor produziu o resultado. */
  engine: "whisperx" | "openai" | "elevenlabs";
}

/**
 * Referência ao clip selecionado na timeline do Premiere (preenchida pelo painel).
 * Os tempos são EM SEGUNDOS na mídia DE ORIGEM (não na sequência).
 */
export interface ClipRef {
  /** Caminho absoluto do arquivo de mídia de origem do clip. */
  mediaPath: string;
  /** In point do clip dentro da mídia de origem. */
  inSec: number;
  /** Out point do clip dentro da mídia de origem. */
  outSec: number;
  /** Frame rate da sequência — usado pra "snapar" os cortes em fronteira de frame. */
  fps: number;
}

/** Motivo pelo qual um trecho foi marcado pra remoção.
 *  "comando" = recado falado pro editor ("vou gravar de novo", "peraí") — nunca vai pro corte. */
export type CutReason = "silencio" | "filler" | "repeticao" | "bad_take" | "comando";

/**
 * Um trecho a REMOVER, em segundos relativos ao áudio transcrito.
 * (O painel soma o offset da origem antes de aplicar na timeline.)
 */
export interface Cut {
  start: number;
  end: number;
  reason: CutReason;
  /** Explicação curta: a palavra-filler, a ideia repetida, o motivo do bad take. */
  detail?: string;
  /**
   * Entra DESMARCADO no painel: o corte é plausível mas a decisão é editorial. Usado pelo
   * "trecho refeito" quando o trecho é longo ou a semelhança é média — nos brutos de matriz
   * (um corpo, vários ganchos) um trecho parecido pode ser outra PEÇA, não uma regravação.
   */
  review?: boolean;
}

/** Um trecho a MANTER (complemento dos cortes) — é o que vira o rough cut. */
export interface KeepSegment {
  start: number;
  end: number;
}

// ===== Segmentação do bruto longo em BLOCOS (lead/corpo/claquete) =====
// O chefe grava um bruto único (40min–1h40) com TODOS os anúncios/reels de uma vez e
// FALA um marcador ao abrir cada peça ("claquete", "lead 2", "corpo 1"). Cada marcador
// confirmado abre um BLOCO, e cada bloco vira UMA sequência (opção A). Determinístico.

/** Marcador FALADO (candidato a fronteira de bloco). Confirmado pelo humano antes de fatiar. */
export interface Marker {
  /** "ad" = peça nova (claquete/anúncio/reels); "take" = bloco-construção (lead/corpo). */
  kind: "ad" | "take";
  /** Rótulo amigável que vai nomear a sequência ("Corpo 1", "Lead 2", "Claquete"). */
  label: string;
  /** O sufixo que rotula o marcador (o "1", "2", "da Raquel") — quando houver. */
  variant?: string;
  /** Índice da palavra-chave na transcrição. */
  wordIndex: number;
  /** Tempo (s) do marcador no stream achatado. */
  startSec: number;
  /** Confiança de ser um marcador de verdade (e não a palavra solta no conteúdo). */
  confidence: "alta" | "baixa";
}

/**
 * Sinal de RETAKE: o chefe anuncia na fala que vai refazer o take ("vou ler de novo",
 * "vou gravar de novo"). O take ANTES do sinal é o ruim → some; o bom é o que vem depois.
 * "alta" = frase inequívoca (entra MARCADA); "baixa" = ambígua (pode ser conteúdo, entra
 * DESMARCADA pra revisão).
 */
export interface RetakeSignal {
  /** Início do trecho que casou a frase-sinal (s, stream achatado). */
  startSec: number;
  /** Fim do trecho que casou a frase-sinal (s) — fronteira do corte do take ruim. */
  endSec: number;
  /** A frase que disparou ("vou ler de novo"). */
  phrase: string;
  /** Índice da 1ª palavra da frase-sinal. */
  wordIndex: number;
  confidence: "alta" | "baixa";
}

// ===== Auto-Zoom (punch-in dinâmico a partir da transcrição) =====
// Acha "pontas de interesse" na fala e propõe um gesto de zoom (escala 100 → até 110 → 100)
// no efeito Transformar, keyframado. Aplicado direto nos clips da V1 (opção B).

export type ZoomStyle = "punch" | "push"; // punch = rápido/forte; push = lento/sutil
export type ZoomTrigger = "numero" | "ideia" | "pergunta";

/** Um keyframe de escala, em tempo ACHATADO (s). 100 = sem zoom (teto 110). */
export interface ZoomKey {
  atSec: number;
  scale: number;
  /** Interpolação temporal do keyframe. */
  ease: "bezier" | "linear" | "hold";
}

/** Um gesto de zoom proposto a partir de um ponto de interesse na transcrição. */
export interface ZoomPoint {
  trigger: ZoomTrigger;
  style: ZoomStyle;
  /** Palavra/frase que disparou (pra revisão humana). */
  word: string;
  /** Janela do gesto no stream achatado (s). */
  startSec: number;
  endSec: number;
  /** Keyframes de escala (tempo achatado), começando e terminando em 100. */
  keys: ZoomKey[];
  /** Índice da palavra-gatilho na transcrição (pra mostrar o contexto). */
  wordIndex: number;
  confidence: "alta" | "baixa";
}

// ===== Estilo da legenda (seletor do painel) =====
// Dois presets de montagem do .srt, a partir das MESMAS palavras transcritas:
//
//   "reels"  = legenda dinâmica, preset "Create Captions" do Premiere. 1 linha de até 14
//              caracteres, mínimo 1,6s, gap 0 → na prática ~1 palavra por legenda.
//   "cinema" = legenda de filme: a frase inteira legível. Até 2 linhas de 42 caracteres,
//              mínimo 5/6 s, máximo 7s, 2 frames de gap, teto de 17 caracteres/segundo de
//              leitura — os números do Netflix Timed Text Style Guide.
//
// O que NÃO muda entre os dois (decisão do Sávio, 28/ago): o texto continua minúsculo e sem
// pontuação nos dois estilos, e a correção de nomes próprios (correcoes.json) roda nos dois.
// O que muda além do formato: no cinema o dinheiro sai em NUMERAL ("R$ 40.000"), enquanto no
// reels sai por extenso ("40 mil reais").
export type CaptionStyle = "reels" | "cinema";

// ===== Contrato das rotas do backend (compartilhado painel <-> servidor) =====

/** Resposta de POST /transcribe. */
export interface TranscribeResponse {
  transcript: TranscriptResult;
  /** Offset (s) a somar aos timestamps pra mapear de volta à mídia de origem. */
  sourceOffsetSec: number;
}

export type CutReasonCounts = Record<CutReason, number>;

export interface AnalyzeStats {
  porMotivo: CutReasonCounts;
  total: number;
  duracaoRemovidaSec: number;
  duracaoTotalSec: number;
}

/** Resposta de POST /analyze. */
export interface AnalyzeResponse {
  cuts: Cut[];
  sourceOffsetSec: number;
  stats: AnalyzeStats;
  /** Marcadores falados detectados (fronteiras de bloco candidatas) — pra segmentação. */
  markers?: Marker[];
  /** Sinais de retake detectados na fala do chefe. */
  retakeSignals?: RetakeSignal[];
  /** Pontos de zoom (punch-in) detectados na transcrição — pro Auto-Zoom. */
  zoomPoints?: ZoomPoint[];
}
