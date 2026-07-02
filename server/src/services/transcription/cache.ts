// Cache em disco da TRANSCRIÇÃO (o passo lento: WhisperX). A chave é a assinatura da mídia
// pedida — caminho + in/out + tamanho/mtime do arquivo — mais idioma, engine e prompt. Assim,
// re-transcrever a MESMA sequência (depois de um reload do painel, por exemplo) lê o resultado
// do disco em vez de rodar o WhisperX de novo. Sobrevive a reload do painel E a reinício do
// backend. Se o arquivo de mídia mudar (tamanho/mtime), a assinatura muda e o cache invalida.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { config } from "../../config";
import { log } from "../../logger";
import type { TranscriptResult } from "../../../../shared/types";

/** O que define unicamente uma transcrição (a mídia + os parâmetros que mudam o resultado). */
export interface CacheKeyInput {
  /** Nome do engine (whisperx/openai) — transcrições de engines diferentes não se misturam. */
  engine: string;
  language: string;
  prompt?: string;
  /** Parâmetros do transcritor que MUDAM o resultado (modelo, align, condition_prev…). Mudar
   *  qualquer um invalida o cache automaticamente — sem isso, ajustar a config devolvia o
   *  transcript velho (ex.: o com o buraco de "......."). */
  engineConfig?: Record<string, unknown>;
  /** Pedaços de mídia que compõem o áudio (1 = clip único; vários = stream achatado). */
  parts: Array<{ mediaPath: string; inSec?: number; outSec?: number }>;
}

/** O que é guardado por chave: a transcrição + o offset de origem (resposta do /transcribe). */
export interface CachedTranscript {
  transcript: TranscriptResult;
  sourceOffsetSec: number;
}

const VERSION = "v1"; // mude pra invalidar todo o cache se o formato da entrada mudar

/** Assinatura estável de um arquivo: tamanho + mtime (ms). "0:0" se não existir/der erro. */
function fileStamp(p: string): string {
  try {
    const st = statSync(p);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return "0:0";
  }
}

function round3(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

/** Chave determinística (sha256) da transcrição pedida. */
export function transcriptCacheKey(input: CacheKeyInput): string {
  const canon = {
    v: VERSION,
    engine: input.engine,
    language: input.language,
    prompt: input.prompt ?? "",
    engineConfig: input.engineConfig ?? {},
    parts: input.parts.map((p) => ({
      mediaPath: p.mediaPath,
      inSec: round3(p.inSec),
      outSec: round3(p.outSec),
      stamp: fileStamp(p.mediaPath),
    })),
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

function entryPath(key: string): string {
  return path.join(config.transcriptCache.dir, `${key}.json`);
}

/** Lê do cache, ou null se não houver / estiver corrompido / cache desligado. */
export function readTranscriptCache(key: string): CachedTranscript | null {
  if (!config.transcriptCache.enabled) return null;
  const file = entryPath(key);
  try {
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf8")) as CachedTranscript;
    if (!data || !data.transcript || !Array.isArray(data.transcript.words)) return null;
    return data;
  } catch (e) {
    log.warn(`cache de transcrição ilegível (${key.slice(0, 8)}): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Grava no cache e poda os mais antigos (mantém os maxEntries mais recentes). */
export function writeTranscriptCache(key: string, value: CachedTranscript): void {
  if (!config.transcriptCache.enabled) return;
  try {
    mkdirSync(config.transcriptCache.dir, { recursive: true });
    writeFileSync(entryPath(key), JSON.stringify(value));
    pruneCache();
  } catch (e) {
    log.warn(`não consegui gravar o cache de transcrição: ${e instanceof Error ? e.message : e}`);
  }
}

/** Mantém só os N arquivos mais recentes no diretório de cache. */
function pruneCache(): void {
  const dir = config.transcriptCache.dir;
  const max = config.transcriptCache.maxEntries;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  if (files.length <= max) return;
  const withTime = files.map((f) => {
    const full = path.join(dir, f);
    let mtime = 0;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      /* ignora */
    }
    return { full, mtime };
  });
  withTime.sort((a, b) => b.mtime - a.mtime); // mais novo primeiro
  for (const old of withTime.slice(max)) {
    try {
      unlinkSync(old.full);
    } catch {
      /* ignora */
    }
  }
}
