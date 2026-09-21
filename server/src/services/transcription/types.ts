// Interface comum de transcrição. Trocar de motor (WhisperX <-> OpenAI <-> ElevenLabs) não
// afeta o resto do pipeline — todo mundo programa contra `Transcriber`.
import type { TranscriptResult } from "../../../../shared/types";

export interface TranscribeOptions {
  /** Idioma, ex: "pt". */
  language: string;
  /** Termos/nomes próprios pra orientar o modelo (jargão clínico, nomes de alunas, etc.). */
  prompt?: string;
  /** Aborta a transcrição (mata o subprocesso) — disparado quando o cliente cancela. */
  signal?: AbortSignal;
  /**
   * true (padrão) = transcrição LITERAL, com hesitação e falso começo — o que o corte precisa.
   * false = texto limpo, pra LEGENDA: sem hesitação, sem "--" e com número em algarismo.
   * Só o ElevenLabs diferencia os dois (no_verbatim); o WhisperX ignora.
   * Motivo (21/09): no modo literal o Scribe escreve número por extenso ("seiscentos reais",
   * zero algarismos num bruto de 5 min), o que contrariava a decisão de dinheiro em algarismo
   * na legenda cinema. O modo limpo devolve "R$ 97", "3 mil" (gerador de cinema de 15/09).
   */
  verbatim?: boolean;
}

export interface Transcriber {
  readonly name: "whisperx" | "openai" | "elevenlabs";
  transcribe(wavPath: string, opts: TranscribeOptions): Promise<TranscriptResult>;
}
