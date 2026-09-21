// Transcritor via ElevenLabs Scribe v2 — motor 3 do AutoCut (v2, 21/set/2026).
//
// POR QUE VERBATIM (no_verbatim=false): o AutoCut corta hesitação, falso começo e retake. Se o
// transcritor "limpa" a fala, esses trechos somem do texto e não sobra o que cortar — é a cicatriz
// registrada no Bisturi (docs/APRENDIZADOS.md), que roda Scribe v2 em brutos desde julho.
//
// FORMATO REAL da resposta (conferido em duas respostas gravadas, 08/07 e 15/09):
//   words[] = { text, start, end, type: "word" | "spacing" | "audio_event", speaker_id, logprob }
//   - o campo é `text` (o AutoCut usa `word`) → convertido aqui;
//   - vem um item "spacing" entre cada palavra → descartado;
//   - pontuação vem grudada na palavra ("reais.", "Luiza,"), igual ao WhisperX;
//   - fala cortada vem com "--" no fim ("segurava--") → MANTIDO (é informação pro corte e aparece
//     no Editar por texto); quem tira da legenda é o buildSrt;
//   - há palavras de duração zero (start == end, 5–6 por amostra) → mantidas como vieram;
//   - language_code vem como "por" (ISO 639-3) → o AutoCut segue com o idioma PEDIDO ("pt").
//   - a documentação (lida em 21/09) declara start/end ANULÁVEIS. Nas amostras nunca veio nulo,
//     mas é tratado igual ao WhisperX: tempo ausente herda o fim da palavra anterior.
//
// CHAVE: vem do Keychain do macOS (serviço `elevenlabs-api-key`) e nunca é gravada em arquivo
// nem impressa. Testado em 21/09 que o LaunchAgent do backend lê a chave sem pedir permissão.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openAsBlob, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../../config";
import { log } from "../../logger";
import type { Transcriber, TranscribeOptions } from "./types";
import type { TranscriptResult, Word } from "../../../../shared/types";

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

interface ScribeWord {
  text: string;
  type: "word" | "spacing" | "audio_event";
  start?: number | null;
  end?: number | null;
  logprob?: number;
}

interface ScribeResponse {
  text?: string;
  language_code?: string;
  audio_duration_secs?: number;
  words?: ScribeWord[];
}

// A chave é lida uma vez por processo e fica só em memória.
let chaveEmMemoria: string | null = null;

function lerChaveDoKeychain(): Promise<string> {
  if (chaveEmMemoria) return Promise.resolve(chaveEmMemoria);
  const servico = config.elevenlabs.keychainService;
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", servico, "-w"],
      { timeout: 15000 },
      (err, stdout) => {
        const chave = (stdout ?? "").trim();
        if (err || !chave) {
          // Nunca inclui stdout na mensagem: se vier algo, pode ser a própria chave.
          reject(
            new Error(
              `Não consegui ler a chave do ElevenLabs no Keychain (serviço "${servico}"). ` +
                `Confira com: security find-generic-password -s ${servico} -w | wc -c`,
            ),
          );
          return;
        }
        chaveEmMemoria = chave;
        resolve(chave);
      },
    );
  });
}

/**
 * Banco de grafias enviado como `keyterms` — DESLIGADO por padrão (ELEVENLABS_KEYTERMS_FILE vazio).
 * Motivo: o vocabulário-guia equivalente no WhisperX vazou como fala fantasma (ver config.ts,
 * whisperx.initialPrompt). Com keyterms ninguém mediu isso ainda — e ele custa +20% por hora.
 * Aplica os limites da API (21/09): < 50 caracteres, até 5 palavras, no máximo 1000 termos.
 */
function lerKeyterms(): string[] {
  const arquivo = config.elevenlabs.keytermsFile;
  if (!arquivo) return [];
  const termos = readFileSync(arquivo, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .filter((l) => l.length < 50 && l.split(/\s+/).length <= 5);
  return termos.slice(0, 1000);
}

/**
 * Parâmetros que mudam o RESULTADO da transcrição — entram na chave do cache, pra que trocar
 * modelo ou banco de grafias force re-transcrever em vez de devolver a versão antiga do disco.
 */
export function elevenlabsEngineConfig(verbatim = true): Record<string, unknown> {
  const arquivo = config.elevenlabs.keytermsFile;
  const keyterms = arquivo
    ? createHash("sha1").update(readFileSync(arquivo)).digest("hex").slice(0, 12)
    : "";
  return { model: config.elevenlabs.model, verbatim, audioEvents: config.elevenlabs.audioEvents, keyterms };
}

/** Converte a resposta do Scribe na lista de palavras do AutoCut. */
export function scribeParaPalavras(dados: ScribeResponse): Word[] {
  const out: Word[] = [];
  let ultimoFim = 0;
  for (const w of dados.words ?? []) {
    if (w.type !== "word") continue; // "spacing" e "audio_event" não são fala
    // Mesmo critério do WhisperX: token que é SÓ pontuação não é palavra.
    if (!w.text || !w.text.replace(/[\s.,;:!?…"'"'’“”«»¡¿()\[\]{}—–-]/gu, "")) continue;
    const start = typeof w.start === "number" ? w.start : ultimoFim;
    const end = typeof w.end === "number" ? Math.max(w.end, start) : start;
    ultimoFim = end;
    out.push({ word: w.text, start, end });
  }
  return out;
}

export class ElevenLabsScribeTranscriber implements Transcriber {
  readonly name = "elevenlabs" as const;

  async transcribe(wavPath: string, opts: TranscribeOptions): Promise<TranscriptResult> {
    if (opts.signal?.aborted) throw new Error("Transcrição cancelada.");
    const chave = await lerChaveDoKeychain();

    // O Scribe não tem campo de prompt livre: vocabulário entra só por keyterms (arquivo).
    if (opts.prompt) log.info("ElevenLabs: o prompt de transcrição é ignorado (o Scribe não aceita prompt).");

    const form = new FormData();
    // openAsBlob lê o WAV do disco sob demanda — não carrega o arquivo inteiro na memória.
    form.append("file", await openAsBlob(wavPath, { type: "audio/wav" }), "audio.wav");
    form.append("model_id", config.elevenlabs.model);
    form.append("language_code", opts.language);
    form.append("timestamps_granularity", "word");
    // CRÍTICO pro corte: literal (no_verbatim=false) mantém hesitação e falso começo. A legenda
    // pede o modo limpo (verbatim=false): número em algarismo, sem "--", sem hesitação.
    const literal = opts.verbatim !== false;
    form.append("no_verbatim", literal ? "false" : "true");
    form.append("diarize", "false");
    form.append("tag_audio_events", config.elevenlabs.audioEvents ? "true" : "false");
    const keyterms = lerKeyterms();
    for (const t of keyterms) form.append("keyterms", t);

    // Cancelar no painel interrompe o ENVIO (não só a espera); e um teto de tempo evita pendurar.
    const limite = AbortSignal.timeout(config.elevenlabs.timeoutSec * 1000);
    const sinal = opts.signal ? AbortSignal.any([opts.signal, limite]) : limite;

    log.info(
      `ElevenLabs ${config.elevenlabs.model} (${literal ? "literal, pro corte" : "limpo, pra legenda"}${keyterms.length ? `, ${keyterms.length} keyterms` : ""})`,
    );
    const inicio = Date.now();
    let res: Response;
    try {
      res = await fetch(SCRIBE_URL, {
        method: "POST",
        headers: { "xi-api-key": chave },
        body: form,
        signal: sinal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new Error("Transcrição cancelada.");
      if (limite.aborted) {
        throw new Error(`ElevenLabs não respondeu em ${config.elevenlabs.timeoutSec}s.`);
      }
      throw new Error(`Falha de rede ao falar com o ElevenLabs: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new Error(`ElevenLabs Scribe falhou: HTTP ${res.status} — ${(await res.text()).slice(0, 500)}`);
    }

    const dados = (await res.json()) as ScribeResponse;
    if (config.elevenlabs.rawDir) {
      try {
        mkdirSync(config.elevenlabs.rawDir, { recursive: true });
        const arq = path.join(config.elevenlabs.rawDir, `scribe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        writeFileSync(arq, JSON.stringify(dados));
        log.info(`ElevenLabs: resposta crua guardada em ${arq}`);
      } catch (e) {
        log.info(`ElevenLabs: não consegui guardar a resposta crua (${(e as Error).message}) — seguindo.`);
      }
    }
    const words = scribeParaPalavras(dados);
    const durationSec =
      typeof dados.audio_duration_secs === "number"
        ? dados.audio_duration_secs
        : words.length
          ? words[words.length - 1].end
          : 0;
    log.info(
      `ElevenLabs respondeu em ${((Date.now() - inicio) / 1000).toFixed(1)}s: ${words.length} palavras, ${durationSec.toFixed(1)}s de áudio.`,
    );

    return {
      words,
      text: (dados.text ?? "").trim(),
      language: opts.language, // o Scribe devolve "por"; o resto do AutoCut trabalha com "pt"
      durationSec,
      engine: "elevenlabs",
    };
  }
}
