// Transcritor via API do OpenAI (whisper-1). Espelha o pipeline já validado do
// skill vsl-editor: verbose_json + timestamp_granularities[]=word -> word-level.
// IMPORTANTE: word-level só existe no whisper-1 (os modelos gpt-4o-transcribe não
// suportam timestamp_granularities).
import { readFile } from "node:fs/promises";
import { config } from "../../config";
import { log } from "../../logger";
import type { Transcriber, TranscribeOptions } from "./types";
import type { TranscriptResult, Word } from "../../../../shared/types";

interface OpenAiVerboseJson {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number }>;
}

export class OpenAiWhisperTranscriber implements Transcriber {
  readonly name = "openai" as const;

  async transcribe(wavPath: string, opts: TranscribeOptions): Promise<TranscriptResult> {
    if (!config.openai.apiKey) {
      throw new Error(
        "OPENAI_API_KEY ausente. Defina no server/.env ou use TRANSCRIBER=whisperx.",
      );
    }

    const buf = await readFile(wavPath);
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
    form.append("model", config.openai.model);
    form.append("language", opts.language);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    if (opts.prompt) form.append("prompt", opts.prompt);

    log.info("OpenAI Whisper", config.openai.model);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`OpenAI Whisper falhou: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as OpenAiVerboseJson;
    const words: Word[] = (data.words ?? []).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
    }));

    return {
      words,
      text: data.text ?? "",
      language: data.language ?? opts.language,
      durationSec: data.duration ?? (words.length ? words[words.length - 1].end : 0),
      engine: "openai",
    };
  }
}
