// Fábrica de transcritores: decide a implementação a partir da config.
import { config } from "../../config";
import type { Transcriber } from "./types";
import { WhisperxTranscriber } from "./whisperxLocal";
import { OpenAiWhisperTranscriber } from "./openaiWhisper";
import { ElevenLabsScribeTranscriber } from "./elevenlabsScribe";

export function makeTranscriber(): Transcriber {
  switch (config.transcriber) {
    case "openai":
      return new OpenAiWhisperTranscriber();
    case "elevenlabs":
      return new ElevenLabsScribeTranscriber();
    case "whisperx":
    default:
      return new WhisperxTranscriber();
  }
}

export type { Transcriber, TranscribeOptions } from "./types";
