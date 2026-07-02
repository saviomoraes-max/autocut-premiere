// Fábrica de transcritores: decide a implementação a partir da config.
import { config } from "../../config";
import type { Transcriber } from "./types";
import { WhisperxTranscriber } from "./whisperxLocal";
import { OpenAiWhisperTranscriber } from "./openaiWhisper";

export function makeTranscriber(): Transcriber {
  switch (config.transcriber) {
    case "openai":
      return new OpenAiWhisperTranscriber();
    case "whisperx":
    default:
      return new WhisperxTranscriber();
  }
}

export type { Transcriber, TranscribeOptions } from "./types";
