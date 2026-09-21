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
}

export class BackendClient {
  constructor(private cfg: BackendConfig = { baseUrl: DEFAULT_BASE_URL }) {}

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
    silence?: { thresholdDb?: number; minSilenceSec?: number };
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
      throw new Error(
        `Não consegui falar com o backend em ${this.cfg.baseUrl}. O servidor está rodando? (npm --prefix server start)`,
      );
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
