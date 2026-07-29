// Transcritor WhisperX local: chama o binário do venv como subprocesso,
// lê o JSON gerado e normaliza pra `TranscriptResult`.
//
// Invocação equivalente à manual:
//   whisperx audio.wav --model large-v3 --language pt \
//     --align_model jonatasgrosman/wav2vec2-large-xlsr-53-portuguese \
//     --device cpu --compute_type int8 --output_format json --output_dir <tmp>
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../../config";
import { log } from "../../logger";
import type { Transcriber, TranscribeOptions } from "./types";
import type { TranscriptResult, Word } from "../../../../shared/types";

// Schema parcial do JSON que o WhisperX grava.
interface WhisperxWord {
  word: string;
  start?: number; // o forced-align pode não atribuir tempo a dígitos/símbolos
  end?: number;
  score?: number;
}
interface WhisperxJson {
  segments?: Array<{ start: number; end: number; text: string; words?: WhisperxWord[] }>;
  word_segments?: WhisperxWord[];
  language?: string;
}

export class WhisperxTranscriber implements Transcriber {
  readonly name = "whisperx" as const;

  async transcribe(wavPath: string, opts: TranscribeOptions): Promise<TranscriptResult> {
    const outDir = await mkdtemp(path.join(tmpdir(), "autocut-wx-"));
    try {
      const args = [
        wavPath,
        "--model", config.whisperx.model,
        "--language", opts.language,
        "--align_model", config.whisperx.alignModel,
        "--device", config.whisperx.device,
        "--compute_type", config.whisperx.computeType,
        "--batch_size", String(config.whisperx.batchSize),
        // Anti-alucinação: não condiciona no texto anterior (tira o loop de "......." que
        // engolia trechos de fala). Configurável por WHISPERX_CONDITION_PREV.
        "--condition_on_previous_text", config.whisperx.conditionOnPreviousText ? "True" : "False",
        "--output_format", "json",
        "--output_dir", outDir,
        "--print_progress", "True",
      ];
      // --initial_prompt ensina nomes próprios/jargões ao modelo (vocabulário-guia de domínio,
      // NÃO instrução de corte). opts.prompt sobrescreve o default da config, se vier.
      const initialPrompt = opts.prompt || config.whisperx.initialPrompt;
      if (initialPrompt) args.push("--initial_prompt", initialPrompt);

      await runWhisperx(config.whisperx.bin, args, opts.signal);

      // O WhisperX grava <basename-sem-ext>.json dentro do outDir.
      const base = path.basename(wavPath).replace(/\.[^.]+$/, "");
      const jsonPath = path.join(outDir, `${base}.json`);
      const raw = JSON.parse(await readFile(jsonPath, "utf8")) as WhisperxJson;

      const words = normalizeWords(raw);
      const text = (raw.segments ?? [])
        .map((s) => s.text.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const durationSec = words.length ? words[words.length - 1].end : 0;

      return { words, text, language: raw.language ?? opts.language, durationSec, engine: "whisperx" };
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
}

/**
 * Usa `word_segments` (lista achatada de todas as palavras); na falta, achata
 * `segments[].words`. Preenche start/end ausentes com o fim da palavra anterior
 * pra não abrir buraco na linha do tempo.
 */
function normalizeWords(raw: WhisperxJson): Word[] {
  const src: WhisperxWord[] =
    raw.word_segments && raw.word_segments.length
      ? raw.word_segments
      : (raw.segments ?? []).flatMap((s) => s.words ?? []);

  const out: Word[] = [];
  let lastEnd = 0;
  for (const w of src) {
    // Descarta tokens que são SÓ pontuação (ex.: "." soltos que o Whisper alucina num trecho
    // sem fala clara) — não são palavras, virariam legenda vazia e poluem o transcript.
    if (!w.word || !w.word.replace(/[\s.,;:!?…"'"'’“”«»¡¿()\[\]{}—–-]/gu, "")) continue;
    const start = typeof w.start === "number" ? w.start : lastEnd;
    const end = typeof w.end === "number" ? w.end : start;
    lastEnd = end;
    out.push({ word: w.word, start, end, score: w.score });
  }
  return out;
}

function runWhisperx(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Já cancelado antes de começar: nem dispara.
    if (signal?.aborted) return reject(new Error("Transcrição cancelada."));

    log.info("WhisperX", bin, args.join(" "));
    // `signal` faz o Node mandar SIGTERM no subprocesso quando o cliente cancela.
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stderr = "";
    let cancelado = false;
    // Preenchido pelo watchdog quando ele mata o processo por falta de progresso.
    let motivoTravado = "";
    let pararWatchdog: () => void = () => {};

    const onAbort = () => {
      cancelado = true;
      pararWatchdog();
      log.info("Transcrição cancelada — matando o WhisperX.");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    if (config.whisperx.watchdog.enabled && child.pid) {
      pararWatchdog = vigiarProgresso(child, (motivo) => {
        motivoTravado = motivo;
        log.info("WhisperX TRAVADO —", motivo);
        matarArvore(child);
      });
    }

    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      pararWatchdog();
      if (motivoTravado) return reject(new Error(motivoTravado));
      // AbortError (subprocesso morto pelo signal) vira um cancelamento limpo.
      if (cancelado || (err as NodeJS.ErrnoException).name === "AbortError") {
        reject(new Error("Transcrição cancelada."));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      pararWatchdog();
      // Travado vem ANTES do código de saída: o processo morreu porque NÓS matamos, então
      // o código seria enganoso ("saiu com código null") e esconderia a causa real.
      if (motivoTravado) reject(new Error(motivoTravado));
      else if (cancelado) reject(new Error("Transcrição cancelada."));
      else if (code === 0) resolve();
      else reject(new Error(`WhisperX saiu com código ${code}.\n${stderr.slice(-2000)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Watchdog de progresso
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);

interface AmostraProcesso {
  cpuSec: number; // CPU acumulada desde o início do processo
  rssMb: number;
  estado: string; // R=rodando, S=dormindo, U=espera ininterrupta (típico de thrashing)
}

/**
 * Lê a CPU acumulada do processo via `ps`. Devolve null quando o processo já morreu
 * (o `ps` sai com código 1 e cai no catch) — o watchdog trata isso como "não avalia".
 */
async function amostrarProcesso(pid: number): Promise<AmostraProcesso | null> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "time=,rss=,state=", "-p", String(pid)]);
    const campos = stdout.trim().split(/\s+/);
    const cpuSec = parseTempoCpu(campos[0] ?? "");
    if (cpuSec === null) return null;
    return {
      cpuSec,
      rssMb: Math.round(Number(campos[1] ?? 0) / 1024),
      estado: campos[2] ?? "?",
    };
  } catch {
    return null;
  }
}

/**
 * Converte o TIME do `ps` em segundos. Formatos possíveis: "SS.ss", "MM:SS.ss",
 * "HH:MM:SS" e "DD-HH:MM:SS".
 */
export function parseTempoCpu(txt: string): number | null {
  const t = txt.trim();
  if (!t) return null;
  const [diasTxt, resto] = t.includes("-") ? t.split("-", 2) : ["0", t];
  const dias = Number(diasTxt);
  const partes = (resto ?? "").split(":").map(Number);
  if (!Number.isFinite(dias) || !partes.length || partes.some((n) => !Number.isFinite(n))) {
    return null;
  }
  // Acumula em base 60 da esquerda pra direita: [H,M,S] → ((H*60)+M)*60+S.
  const seg = partes.reduce((acc, p) => acc * 60 + p, 0);
  return dias * 86400 + seg;
}

/**
 * Amostra a CPU acumulada do subprocesso a cada `pollSec`. Se o ganho por amostra ficar
 * abaixo de `minCpuSec` por `stallSec` seguidos, chama `aoTravar`. Devolve a função que
 * desliga o watchdog (chamada em todo caminho de saída, inclusive cancelamento).
 */
function vigiarProgresso(child: ChildProcess, aoTravar: (motivo: string) => void): () => void {
  const cfg = config.whisperx.watchdog;
  const pid = child.pid!;
  let ligado = true;
  let timer: NodeJS.Timeout | null = null;
  let cpuAnterior: number | null = null;
  let paradoSec = 0;

  const tick = async () => {
    if (!ligado) return;
    const a = await amostrarProcesso(pid);
    // Pode ter sido desligado enquanto o `ps` rodava (processo terminou nesse meio-tempo).
    if (!ligado) return;

    if (a) {
      if (cpuAnterior !== null) {
        const ganho = a.cpuSec - cpuAnterior;
        if (ganho < cfg.minCpuSec) {
          paradoSec += cfg.pollSec;
          log.info(
            `WhisperX sem progresso: ${ganho.toFixed(1)}s de CPU nos últimos ${cfg.pollSec}s ` +
              `(parado há ${paradoSec}s de ${cfg.stallSec}s; rss=${a.rssMb}MB estado=${a.estado})`,
          );
          if (paradoSec >= cfg.stallSec) {
            ligado = false;
            aoTravar(await montarMotivo(paradoSec, a));
            return;
          }
        } else {
          paradoSec = 0; // voltou a trabalhar: zera o contador
        }
      }
      cpuAnterior = a.cpuSec;
    }

    if (ligado) timer = setTimeout(tick, cfg.pollSec * 1000);
  };

  timer = setTimeout(tick, cfg.pollSec * 1000);
  return () => {
    ligado = false;
    if (timer) clearTimeout(timer);
  };
}

/** Mensagem de erro que chega ao painel — nomeia a causa provável em vez de "falhou". */
async function montarMotivo(paradoSec: number, a: AmostraProcesso): Promise<string> {
  const min = (paradoSec / 60).toFixed(1);
  let swap = "";
  try {
    const { stdout } = await execFileP("sysctl", ["-n", "vm.swapusage"]);
    swap = ` Swap do Mac no momento: ${stdout.trim()}.`;
  } catch {
    /* diagnóstico é bônus: se o sysctl falhar, a mensagem principal já basta */
  }
  return (
    `WhisperX travou: ${min} min sem consumir CPU (estado "${a.estado}", ${a.rssMb} MB residentes). ` +
    `Quase sempre é falta de memória — o processo fica paginando em vez de transcrever.${swap} ` +
    `Abortei em vez de deixar o painel girando à toa. Libere memória (feche apps pesados, ` +
    `mate processos órfãos) e rode de novo.`
  );
}

/** Mata o WhisperX e os workers que ele tiver aberto (SIGKILL: em estado "U" o TERM não pega). */
function matarArvore(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  // Filhos primeiro, senão viram órfãos segurando memória — exatamente o que motivou isto.
  execFile("pkill", ["-9", "-P", String(pid)], () => {});
  try {
    child.kill("SIGKILL");
  } catch {
    /* já morreu */
  }
}
