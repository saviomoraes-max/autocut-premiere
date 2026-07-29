// Carrega e valida a configuração do backend a partir do server/.env.
// Nenhum segredo é hardcoded — tudo vem de variável de ambiente, com defaults sensatos.
import "dotenv/config";
import path from "node:path";
import os from "node:os";

// Caminho padrão do whisperx instalado no venv dedicado do skill vsl-editor (reaproveitado).
const DEFAULT_WHISPERX_BIN = path.join(
  os.homedir(),
  ".claude/skills/vsl-editor/.venv-whisperx/bin/whisperx",
);

// Scripts de legenda do skill vsl-editor — os MESMOS que o plugin Legendas RECONECTA usa.
// Reusados pra o SRT sair IDÊNTICO (preset Create Captions + dinheiro/nomes), sem duplicar.
const VSL_SCRIPTS = path.join(os.homedir(), ".claude/skills/vsl-editor/scripts");

export type TranscriberKind = "whisperx" | "openai";

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : def;
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: num(process.env.PORT, 7867),

  // Token opcional de auth. Vazio = uso local sem autenticação (costura p/ hospedar depois).
  authToken: process.env.AUTH_TOKEN ?? "",

  language: process.env.LANGUAGE ?? "pt",

  // Cache em disco da TRANSCRIÇÃO (o passo lento: WhisperX). Guardado por assinatura da
  // mídia de entrada (caminho + in/out + tamanho/mtime) + idioma + engine. Re-transcrever a
  // MESMA sequência (ex.: depois de um reload do painel) lê do disco em vez de rodar o
  // WhisperX de novo — sobrevive a reload do painel E a reinício do backend.
  transcriptCache: {
    enabled: (process.env.TRANSCRIPT_CACHE ?? "1") !== "0",
    dir: process.env.TRANSCRIPT_CACHE_DIR ?? path.join(os.homedir(), ".autocut", "transcripts"),
    // Quantas transcrições guardar antes de podar as mais antigas.
    maxEntries: num(process.env.TRANSCRIPT_CACHE_MAX, 60),
  },

  // Default: WhisperX local (sem custo por minuto, offline, pt-BR afinado).
  transcriber: (process.env.TRANSCRIBER ?? "whisperx") as TranscriberKind,

  ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
  ffprobeBin: process.env.FFPROBE_BIN ?? "ffprobe",

  whisperx: {
    bin: process.env.WHISPERX_BIN ?? DEFAULT_WHISPERX_BIN,
    model: process.env.WHISPERX_MODEL ?? "large-v3",
    alignModel:
      process.env.WHISPERX_ALIGN_MODEL ??
      "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese",
    device: process.env.WHISPERX_DEVICE ?? "cpu",
    computeType: process.env.WHISPERX_COMPUTE_TYPE ?? "int8",
    batchSize: num(process.env.WHISPERX_BATCH_SIZE, 8),
    // Alucinação de pontuação/repetição (ex.: "......." num trecho de fala, que some das
    // legendas) vem do modelo se CONDICIONAR no texto anterior. false = transcreve cada janela
    // sem herdar o contexto → tira o loop de "." que fazia sumir fala. O --initial_prompt ainda
    // ensina nomes próprios; o postprocess ainda corrige grafia. WHISPERX_CONDITION_PREV=1 religa.
    conditionOnPreviousText: (process.env.WHISPERX_CONDITION_PREV ?? "0") === "1",
    // VOCABULÁRIO-GUIA (--initial_prompt): DESLIGADO por padrão (2026-07-13). O vocabulário de
    // domínio VAZAVA pra dentro da transcrição como fala fantasma — provado em 3 vídeos sem
    // relação com o nicho (brigadeiro/aluguel), todos com "SUPERCASO"/"Reconecta"/"harmonização"
    // 1× no texto. Palavra fantasma rouba timestamp de fala real → alinhamento descarrilha →
    // wordClamp protege o lugar errado → corte come palavra e deixa respiro. Correção de
    // nomes/termos fica no correcoes.json (pós-processo do SRT, exato e sem risco).
    // WHISPERX_INITIAL_PROMPT no .env religa por conta e risco.
    initialPrompt: process.env.WHISPERX_INITIAL_PROMPT ?? "",
    // WATCHDOG (2026-07-29): quando o Mac fica sem memória, o WhisperX não fica LENTO — ele
    // PARA. Já aconteceu 2× no mesmo dia: 35s de CPU em 25min de relógio, processo em estado
    // "stuck", paginando em vez de transcrever, e o painel girando pra sempre sem erro nenhum.
    // A medida certa de progresso é a CPU CONSUMIDA, não o tempo de parede: uma transcrição
    // saudável de 19min queimou 15:30 de CPU em 11:58 de relógio (386%, multi-thread), então
    // um vídeo longo e legítimo NUNCA é morto por demorar — só o que está de fato parado.
    watchdog: {
      enabled: (process.env.WHISPERX_WATCHDOG ?? "1") !== "0",
      // De quanto em quanto tempo amostrar a CPU acumulada do subprocesso.
      pollSec: num(process.env.WHISPERX_WATCHDOG_POLL_SEC, 30),
      // Quanto tempo parado até abortar. 5min é folgado: carregar o large-v3 do disco leva
      // ~30-60s e CONSOME CPU, então nem a fase de load dispara falso-positivo.
      stallSec: num(process.env.WHISPERX_WATCHDOG_STALL_SEC, 300),
      // Ganho mínimo de CPU (s) por amostra pra contar como progresso. 2s em 30s = 6,7% de
      // um núcleo: qualquer trabalho real passa disso com folga.
      minCpuSec: num(process.env.WHISPERX_WATCHDOG_MIN_CPU_SEC, 2),
    },
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_WHISPER_MODEL ?? "whisper-1",
  },

  // Análise dos cortes com Claude (módulo 2).
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    // Opus 4.8 — qualidade MÁXIMA na detecção de retake (Sávio priorizou qualidade sobre custo/velocidade).
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
    // Profundidade de raciocínio: low | medium | high | max. "max" = o mais alto possível.
    effort: (process.env.ANTHROPIC_EFFORT ?? "max") as "low" | "medium" | "high" | "max",
    // O thinking do effort máximo CONTA no max_tokens. 32k truncava (só vinha o bloco de
    // thinking, sem o JSON). 64k = folga recomendada p/ streaming; teto do Opus 4.8 é 128k.
    maxTokens: num(process.env.ANTHROPIC_MAX_TOKENS, 64000),
  },

  // Motor da análise semântica:
  //   "local"    = filler/gagueira por CÓDIGO, sem LLM (grátis, exato — PADRÃO).
  //   "ollama"   = LLM local (qwen2.5) — atrás do switch; ruim em timestamp preciso (testado).
  //   "anthropic"= API paga (Opus). Silêncio acústico roda sempre, à parte do motor.
  analyzer: (process.env.ANALYZER ?? "local") as "local" | "ollama" | "anthropic",

  // LLM local via Ollama (grátis, roda na máquina). Forma da API confirmada na doc oficial
  // (POST /api/chat com "format" = JSON schema; resposta em message.content).
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen2.5:7b",
    // Janela de contexto. 8192 cobre seleção de poucos clipes com folga de RAM (18GB + Premiere);
    // transcript gigante (timeline inteira ~2900 palavras) precisa de chunking — TODO.
    numCtx: num(process.env.OLLAMA_NUM_CTX, 8192),
  },

  // Detecção acústica de silêncio (ffmpeg silencedetect), módulo 2.
  silence: {
    // Abaixo deste nível (dB) é considerado silêncio. Pode ser mais agressivo (-36)
    // porque a TRAVA POR PALAVRA (wordClamp) garante que nenhum corte toca numa
    // palavra transcrita — então o threshold não precisa mais carregar a segurança.
    thresholdDb: num(process.env.SILENCE_THRESHOLD_DB, -36),
    // Duração mínima (s) pra um silêncio virar corte. 0.35 = mais agressivo (pega as
    // pausas de 0.35-0.6s que ficavam de fora) sem mexer na proteção de palavra.
    minSilenceSec: num(process.env.SILENCE_MIN_SEC, 0.35),
  },

  // Exportar SRT no padrão do plugin Legendas RECONECTA. Reusa os MESMOS scripts do
  // skill vsl-editor (postprocess de dinheiro/nomes → srt.mjs) pra saída idêntica.
  // Preset "Create Captions" do Premiere: 1 linha, ≤14 chars, min 1.6s, gap 0, ≤12 palavras.
  srt: {
    postprocessScript:
      process.env.SRT_POSTPROCESS ?? path.join(VSL_SCRIPTS, "postprocess-transcript.mjs"),
    srtScript: process.env.SRT_SCRIPT ?? path.join(VSL_SCRIPTS, "srt.mjs"),
    maxChars: num(process.env.SRT_MAX_CHARS, 14),
    minDur: num(process.env.SRT_MIN_DUR, 1.6),
    gap: num(process.env.SRT_GAP, 0),
    maxWords: num(process.env.SRT_MAX_WORDS, 12),
    // Adianta (lead>0) ou atrasa (lead<0) TODAS as legendas. 0 = no tempo exato da palavra.
    // Era 0.10 (herdado do plugin legendas) e deixava a legenda À FRENTE da fala — zerado;
    // o ajuste fino vem do painel (campo de sincronia → leadSec).
    lead: num(process.env.SRT_LEAD, 0),
    // ESTILO de direcionamento (pedido do Sávio): legenda toda minúscula, SEM pontuação,
    // com exceção das marcas em CAIXA ALTA. Aplicado como passo final no AutoCut.
    lowercaseNoPunct: (process.env.SRT_LOWERCASE ?? "1") !== "0",
    // Termos preservados em caixa alta (case-sensitive: a forma que o postprocess já produz).
    brandUpper: ["RECONECTA", "SUPERCASO"],
  },
};
