// Cliente HTTP do backend local. Toda a comunicação painel <-> backend passa por aqui.
// COSTURAS DE DISTRIBUIÇÃO: baseUrl é configurável (127.0.0.1 hoje, https://... depois)
// e mandamos sempre o header Authorization (vazio em uso local).
import type {
  CaptionStyle,
  ClipRef,
  Word,
  TranscriptResult,
  TranscribeResponse,
  AnalyzeResponse,
} from "../../../shared/types";

export interface SrtResponse {
  srt: string;
  count: number;
}

// UXP NÃO permite endereço IP em requisições de rede — só nome de domínio.
// Por isso usamos "localhost" (não "127.0.0.1"), que também está no manifest.
export const DEFAULT_BASE_URL = "http://localhost:7867";

export interface BackendConfig {
  baseUrl: string;
  authToken?: string;
}

export interface HealthResponse {
  ok: boolean;
  transcriber: string;
  model: string;
  // Acrescentados no redesign (21/09/2026) — opcionais: um backend antigo não manda.
  /** "local" (detectores por código, sem IA), "anthropic" ou "ollama". */
  analyzer?: string;
  /** Modelo da análise; null na análise local. */
  analyzerModel?: string | null;
  analyzerEffort?: string | null;
  /** Limiar do detector de silêncio (dB). A pausa mínima vem do preset de Respiro do painel. */
  silenceThresholdDb?: number;
}

export class BackendClient {
  /** Última rota chamada + hora — vai no "detalhe técnico" da tela de erro. */
  lastCall: { path: string; at: Date } | null = null;

  constructor(private cfg: BackendConfig = { baseUrl: DEFAULT_BASE_URL }) {}

  /** Endereço atual do backend (a tela de erro e a Config mostram o real, não um exemplo). */
  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  setConfig(cfg: BackendConfig): void {
    this.cfg = cfg;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.authToken) h["Authorization"] = `Bearer ${this.cfg.authToken}`;
    return h;
  }

  async health(): Promise<HealthResponse> {
    const r = await fetch(`${this.cfg.baseUrl}/health`, { headers: this.headers() });
    if (!r.ok) throw new Error(`/health respondeu ${r.status}`);
    return (await r.json()) as HealthResponse;
  }

  /** Transcreve N segmentos achatados num stream contínuo (1 clip = lista de 1). */
  transcribe(
    segments: ClipRef[],
    opts: { language?: string; prompt?: string; signal?: AbortSignal; verbatim?: boolean } = {},
  ): Promise<TranscribeResponse> {
    return this.post<TranscribeResponse>(
      "/transcribe",
      { segments, language: opts.language, prompt: opts.prompt, verbatim: opts.verbatim },
      opts.signal,
    );
  }

  analyze(body: {
    transcript: TranscriptResult;
    segments: ClipRef[];
    userPrompt?: string;
    includeSemantic?: boolean;
    /** Ajuste fino do detector de silêncio (preset de respiro do painel). */
    silence?: { thresholdDb?: number; minSilenceSec?: number; margemInicioSec?: number; margemFimSec?: number };
    signal?: AbortSignal;
  }): Promise<AnalyzeResponse> {
    const { signal, ...rest } = body;
    return this.post<AnalyzeResponse>("/analyze", rest, signal);
  }

  /** Gera o .srt (padrão Legendas RECONECTA) a partir das palavras transcritas.
   *  `style` escolhe entre a legenda dinâmica de reels e a de cinema (frase inteira). */
  srt(
    words: Word[],
    opts: {
      offsetSec?: number;
      leadSec?: number;
      style?: CaptionStyle;
      fps?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<SrtResponse> {
    return this.post<SrtResponse>(
      "/srt",
      { words, offsetSec: opts.offsetSec, leadSec: opts.leadSec, style: opts.style, fps: opts.fps },
      opts.signal,
    );
  }

  /** Manda um snapshot de diagnóstico pro log do servidor (best-effort, não quebra o fluxo). */
  async debug(label: string, data: unknown): Promise<void> {
    try {
      await this.post("/debug", { label, data });
    } catch {
      /* diagnóstico não pode derrubar o corte */
    }
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    if (path !== "/debug") this.lastCall = { path, at: new Date() };
    let r: Response;
    try {
      r = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // Cancelado pelo usuário (AbortController) — propaga um erro reconhecível (name=AbortError).
      if (signal?.aborted || (e as Error)?.name === "AbortError") {
        const ab = new Error("Operação cancelada.");
        ab.name = "AbortError";
        throw ab;
      }
      // O começo desta frase é o que a tela de erro usa pra reconhecer "backend fora do ar".
      throw new Error(`Não consegui falar com o backend em ${this.cfg.baseUrl} (conexão recusada ou sem resposta).`);
    }
    const text = await r.text();
    if (!r.ok) {
      let msg: unknown = text;
      try {
        msg = (JSON.parse(text) as { error?: unknown }).error ?? text;
      } catch {
        /* corpo não-JSON */
      }
      throw new Error(`${path} → ${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    }
    return JSON.parse(text) as T;
  }
}
