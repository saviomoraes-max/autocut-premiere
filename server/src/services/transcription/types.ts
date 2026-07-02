// Interface comum de transcrição. Trocar de motor (WhisperX <-> OpenAI) não
// afeta o resto do pipeline — todo mundo programa contra `Transcriber`.
import type { TranscriptResult } from "../../../../shared/types";

export interface TranscribeOptions {
  /** Idioma, ex: "pt". */
  language: string;
  /** Termos/nomes próprios pra orientar o modelo (jargão clínico, nomes de alunas, etc.). */
  prompt?: string;
  /** Aborta a transcrição (mata o subprocesso) — disparado quando o cliente cancela. */
  signal?: AbortSignal;
}

export interface Transcriber {
  readonly name: "whisperx" | "openai";
  transcribe(wavPath: string, opts: TranscribeOptions): Promise<TranscriptResult>;
}
