// Controlador do painel (vanilla DOM — sem innerHTML, compatível com o subset do UXP).
// Máquina de estados: idle -> busy -> review -> (busy) -> done | error.
import { BackendClient, DEFAULT_BASE_URL, type BackendConfig } from "../api/backendClient";
import {
  proposeCuts,
  applyApprovedCuts,
  applyBlockSequences,
  applyZoomPoints,
  exportSrt,
  type Proposal,
} from "../state/autoedit";
import {
  layoutSegments,
  assessCutsClipImpact,
  isDangerousCut,
  type CutClipImpact,
} from "../../../shared/segments";
import {
  buildBlocks,
  signalsInBlock,
  retakeCutForBlock,
  type Block,
} from "../../../shared/blocks";
import { summarizeZooms } from "../../../shared/zoom";
import { readTimelineAudioSpans, type TimelineAudioSpan } from "../premiere/selection";
import type { Cut, CutReason, Marker, RetakeSignal, ZoomPoint } from "../../../shared/types";

let mounted = false;

export function mountApp(root: HTMLElement): void {
  if (mounted) return;
  mounted = true;
  new PanelController(root);
}

const REASON_LABEL: Record<CutReason, string> = {
  silencio: "Silêncio",
  filler: "Filler",
  repeticao: "Repetição",
  bad_take: "Bad take",
  comando: "Recado",
};

/**
 * Presets de RESPIRO: quanto de pausa sobra em volta de cada corte + qual pausa mínima vira
 * corte. "Natural" = comportamento validado atual (não mudar sem re-auditar). "Seco" corta mais
 * rente (reel dinâmico — pode encostar no decay da fala, escolha editorial). "Suave" respira
 * mais (VSL calmo). Medição 2026-07-16 (RLS004 + bruto SEM27): o detector acha 95%+ das pausas;
 * o gap que sobra no vídeo é ESTA margem — por isso ela é o botão, não o detector.
 */
type RespiroPreset = "seco" | "natural" | "suave";
const RESPIRO: Record<RespiroPreset, { startSec: number; endSec: number; minSilenceSec: number; label: string }> = {
  seco: { startSec: 0.08, endSec: 0.05, minSilenceSec: 0.25, label: "Seco (reel dinâmico)" },
  natural: { startSec: 0.12, endSec: 0.12, minSilenceSec: 0.35, label: "Natural (padrão)" },
  suave: { startSec: 0.18, endSec: 0.15, minSilenceSec: 0.45, label: "Suave (VSL calmo)" },
};

// Mini-helper "hyperscript" para montar DOM sem innerHTML.
type Attrs = Record<string, unknown>;
function make(tag: string, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else if (k === "style") e.setAttribute("style", String(v)); // UXP não aceita e.style = "string"
    else if (k.startsWith("on") && typeof v === "function") {
      e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      (e as unknown as Record<string, unknown>)[k] = v;
    }
  }
  for (const c of children) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

/** Salva o .srt via SELETOR DE ARQUIVO do UXP (o usuário escolhe onde). null = cancelou. */
async function saveSrtFile(srt: string): Promise<string | null> {
  const fs = (
    require("uxp") as {
      storage: {
        localFileSystem: {
          getFileForSaving: (
            name: string,
            opts?: { types?: string[] },
          ) => Promise<{ name?: string; write: (data: string) => Promise<void> } | null>;
        };
      };
    }
  ).storage.localFileSystem;
  const file = await fs.getFileForSaving("legendas.srt", { types: ["srt"] });
  if (!file) return null; // usuário fechou o diálogo
  await file.write(srt);
  return file.name ?? "legendas.srt";
}

class PanelController {
  private client = new BackendClient();
  private cfg: BackendConfig = { baseUrl: DEFAULT_BASE_URL, authToken: "" };
  private userPrompt = "";
  /** Ajuste de sincronia do SRT (s): >0 atrasa a legenda, <0 adianta. */
  private srtSyncSec = 0;
  /** Preset de respiro dos cortes (Seco/Natural/Suave). Vale pro Auto-Edit e pro editor por texto. */
  private respiro: RespiroPreset = "natural";
  private proposal: Proposal | null = null;
  private enabled: boolean[] = [];
  private impacts: CutClipImpact[] = [];
  private markerOn: boolean[] = [];
  private signalOn: boolean[] = [];
  private zoomOn: boolean[] = [];
  private mode: "cut" | "zoom" | "text" = "cut";
  // Editor por texto: por palavra, se está marcada pra REMOVER. + toggle global de silêncio.
  private wordDel: boolean[] = [];
  private removeSilence = true;
  private lastWordClick = -1; // pra shift+clique selecionar um trecho
  private wordSpans: HTMLElement[] = []; // os spans das palavras (atualização pontual)
  // Sync ao vivo timeline→texto: relê a sequência ativa e espelha os cortes no texto.
  private textSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private textSyncSig = ""; // assinatura (in/out dos clipes) da última leitura — detecta mudança
  private syncNoteEl: HTMLElement | null = null; // linha de status do sync no header
  private statusEl: HTMLElement | null = null;
  /** Aborta a transcrição/análise em andamento (botão Cancelar). */
  private abortController: AbortController | null = null;
  // Containers da seção de segmentação — atualizados sem re-renderizar a lista pesada de cortes.
  private segBox: HTMLElement | null = null;
  private headInfo: HTMLElement | null = null;
  private applyBtn: HTMLButtonElement | null = null;

  constructor(private root: HTMLElement) {
    this.renderIdle();
  }

  private clear(): void {
    this.stopTextSync(); // sai do editor por texto → para o poll da timeline
    this.syncNoteEl = null;
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
  }

  private setStatus = (msg: string): void => {
    if (this.statusEl) this.statusEl.textContent = msg;
  };

  // ---------- IDLE ----------
  private renderIdle(): void {
    this.clear();
    this.statusEl = null;

    const promptField = make("textarea", {
      placeholder: "Ex.: corte agressivo, remova pausas longas, mantenha o tom…",
      value: this.userPrompt,
      oninput: (e: Event) => {
        this.userPrompt = (e.target as HTMLTextAreaElement).value;
      },
    });

    const runBtn = make("button", { class: "cta", onclick: () => void this.runPropose("cut") }, [
      make("span", { class: "cta-ico", text: "▸" }),
      make("span", { text: "Auto-Edit" }),
    ]);

    const textBtn = make("button", { class: "cta cta-alt", onclick: () => void this.runPropose("text") }, [
      make("span", { class: "cta-ico", text: "¶" }),
      make("span", { text: "Editar por texto" }),
    ]);

    const zoomBtn = make("button", { class: "cta cta-alt", onclick: () => void this.runPropose("zoom") }, [
      make("span", { class: "cta-ico", text: "⤢" }),
      make("span", { text: "Auto-Zoom" }),
    ]);

    const srtBtn = make("button", { class: "cta cta-alt", onclick: () => void this.runExportSrt() }, [
      make("span", { class: "cta-ico", text: "❝" }),
      make("span", { text: "Exportar SRT" }),
    ]);

    // RESPIRO do corte: quanto de pausa sobra em cada ponto de corte (escolha editorial).
    const respiroSel = make("select", {
      onchange: (e: Event) => {
        this.respiro = (e.target as HTMLSelectElement).value as RespiroPreset;
      },
    }) as HTMLSelectElement;
    for (const [key, p] of Object.entries(RESPIRO)) {
      const opt = make("option", { value: key, text: p.label }) as HTMLOptionElement;
      if (key === this.respiro) opt.selected = true;
      respiroSel.appendChild(opt);
    }
    const respiroRow = make("div", { class: "srt-sync" }, [
      make("span", { class: "srt-sync-label", text: "Respiro dos cortes" }),
      respiroSel,
    ]);

    // Ajuste fino de sincronia da legenda (s): positivo ATRASA, negativo ADIANTA.
    const srtSyncInput = make("input", {
      type: "text",
      value: String(this.srtSyncSec),
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value.replace(",", "."));
        this.srtSyncSec = Number.isFinite(v) ? v : 0;
      },
    });
    const srtSyncRow = make("div", { class: "srt-sync" }, [
      make("span", { class: "srt-sync-label", text: "Sincronia da legenda (s): + atrasa · − adianta" }),
      srtSyncInput,
    ]);

    const step = (n: string, t: string): HTMLElement =>
      make("div", { class: "hint-row" }, [
        make("span", { class: "hint-num", text: n }),
        make("span", { text: t }),
      ]);

    this.root.appendChild(
      make("div", { class: "pad" }, [
        // Cabeçalho com identidade
        make("div", { class: "hero" }, [
          make("div", { class: "hero-badge", text: "AC" }),
          make("div", {}, [
            make("div", { class: "hero-title", text: "AutoCut" }),
            make("div", { class: "hero-tag", text: "Rough cut automático com IA" }),
          ]),
        ]),
        // Como funciona (3 passos)
        make("div", { class: "hint" }, [
          step("1", "Transcreve o áudio dos clips"),
          step("2", "Detecta os marcadores falados (lead, corpo…)"),
          step("3", "Cria uma sequência limpa por peça"),
        ]),
        make("label", { text: "Instruções (opcional)" }),
        promptField,
        runBtn,
        textBtn,
        zoomBtn,
        srtBtn,
        respiroRow,
        srtSyncRow,
        make("p", {
          class: "note-line",
          text: "Auto-Edit corta silêncio/filler e segmenta. Auto-Zoom põe punch-in nas ênfases. Exportar SRT gera a legenda no padrão Legendas RECONECTA. Roda na seleção, ou na sequência inteira se nada estiver selecionado.",
        }),
        this.buildBackendSection(),
      ]),
    );
  }

  private buildBackendSection(): HTMLElement {
    const dot = make("span", { class: "dot" });
    const statusText = make("span", { text: "verificando backend…" });

    const refresh = () => {
      dot.className = "dot";
      statusText.textContent = "verificando backend…";
      this.client.setConfig(this.cfg);
      this.client
        .health()
        .then((h) => {
          dot.className = "dot ok";
          statusText.textContent = `backend ok — ${h.transcriber} (${h.model})`;
        })
        .catch(() => {
          dot.className = "dot off";
          statusText.textContent = "backend offline (rode: npm --prefix server start)";
        });
    };

    const urlInput = make("input", {
      type: "text",
      value: this.cfg.baseUrl,
      oninput: (e: Event) => {
        this.cfg.baseUrl = (e.target as HTMLInputElement).value;
      },
    });
    const tokenInput = make("input", {
      type: "text",
      placeholder: "Authorization token (vazio em uso local)",
      value: this.cfg.authToken ?? "",
      oninput: (e: Event) => {
        this.cfg.authToken = (e.target as HTMLInputElement).value;
      },
    });

    const config = make("div", { class: "config-section config-hidden" }, [
      make("label", { text: "Backend URL" }),
      urlInput,
      make("label", { text: "Token" }),
      tokenInput,
      make("div", { class: "row" }, [
        make("button", { class: "secondary", text: "Reconectar", onclick: refresh }),
      ]),
    ]);

    const toggle = make("button", {
      class: "linkbtn",
      text: "Config",
      onclick: () => {
        config.classList.toggle("config-hidden");
      },
    });

    const section = make("div", { class: "backend" }, [
      make("div", { class: "backend-bar" }, [
        make("div", { class: "statuspill" }, [dot, statusText]),
        toggle,
      ]),
      config,
    ]);

    refresh();
    return section;
  }

  // ---------- BUSY ----------
  // Com onCancel: mostra um botão Cancelar (usado durante transcrição/análise, que podem demorar).
  private renderBusy(msg: string, onCancel?: () => void): void {
    this.clear();
    this.statusEl = make("p", { class: "status", text: msg });
    const filhos: (Node | string)[] = [make("h1", { text: "AutoCut" }), this.statusEl];
    if (onCancel) {
      filhos.push(
        make("div", { class: "row" }, [
          make("button", { class: "secondary full", text: "Cancelar", onclick: onCancel }),
        ]),
      );
      filhos.push(
        make("p", { class: "note-line", text: "Pode cancelar a qualquer momento — nada é alterado na timeline." }),
      );
    }
    this.root.appendChild(make("div", { class: "pad" }, filhos));
  }

  private async runPropose(mode: "cut" | "zoom" | "text"): Promise<void> {
    this.mode = mode;
    // Aborta qualquer transcrição anterior ainda viva — sem isto, clicar de novo deixava DOIS
    // WhisperX rodando em paralelo no backend (CPU dividida = os dois 2× mais lentos).
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.renderBusy("Iniciando…", () => this.cancelPropose());
    try {
      this.client.setConfig(this.cfg);
      this.proposal = await proposeCuts(
        this.client,
        this.userPrompt || undefined,
        this.setStatus,
        this.abortController.signal,
        { minSilenceSec: RESPIRO[this.respiro].minSilenceSec },
      );
      if (mode === "zoom") {
        // Auto-Zoom: zoom de confiança ALTA já vem marcado; BAIXA (ideia fraca) desmarcado.
        this.zoomOn = this.proposal.zoomPoints.map((z) => z.confidence === "alta");
        this.renderZoomReview();
        return;
      }
      if (mode === "text") {
        // Editor por texto: muletas (filler/gagueira) já vêm RISCADAS; silêncios via toggle.
        const words = this.proposal.transcript.words;
        const fillerRanges = this.proposal.cuts.filter((c) => c.reason !== "silencio");
        this.wordDel = words.map((w) =>
          fillerRanges.some((c) => w.start < c.end && w.end > c.start),
        );
        this.removeSilence = true;
        this.lastWordClick = -1;
        this.renderTextEditor();
        return;
      }
      // TRAVA DE SEGURANÇA: mede quanto cada corte apaga de cada clipe. Corte que
      // remove ~um clipe inteiro (take/bloco) vem DESMARCADO por padrão — nada some
      // sozinho; o editor decide se quer mesmo descartar o take.
      const layout = layoutSegments(
        this.proposal.segments.map((s) => ({
          flatDurSec: s.audio.clipRef.outSec - s.audio.clipRef.inSec,
        })),
      );
      this.impacts = assessCutsClipImpact(this.proposal.cuts, layout.laid);
      this.enabled = this.proposal.cuts.map((_, i) => !isDangerousCut(this.impacts[i]));
      // Defaults da segmentação: marcador/retake de confiança ALTA já vem marcado; BAIXA
      // (provável conteúdo) vem desmarcado pra revisão. O humano confirma as fronteiras.
      this.markerOn = this.proposal.markers.map((m) => m.confidence === "alta");
      this.signalOn = this.proposal.retakeSignals.map((s) => s.confidence === "alta");
      this.renderReview();
    } catch (err) {
      // Cancelado pelo usuário → volta pro início, sem cara de erro.
      if (this.isAbort(err)) this.renderIdle();
      else this.renderError(err);
    } finally {
      this.abortController = null;
    }
  }

  /** Cancela a transcrição/análise em andamento (aborta a requisição → mata o WhisperX). */
  private cancelPropose(): void {
    this.abortController?.abort();
    this.renderBusy("Cancelando…");
  }

  private isAbort(err: unknown): boolean {
    return !!err && (err as Error).name === "AbortError";
  }

  // ---------- EXPORTAR SRT ----------
  private async runExportSrt(): Promise<void> {
    this.abortController?.abort(); // mata request anterior ainda vivo (evita WhisperX duplicado)
    this.abortController = new AbortController();
    this.renderBusy("Transcrevendo pra legenda…", () => this.cancelPropose());
    try {
      this.client.setConfig(this.cfg);
      const { srt, count } = await exportSrt(
        this.client,
        this.setStatus,
        this.abortController.signal,
        this.srtSyncSec,
      );
      this.setStatus("Salvando o .srt…");
      const nome = await saveSrtFile(srt);
      if (nome) this.renderDone(`Pronto! ${count} legenda(s) salvas em "${nome}".`);
      else this.renderIdle(); // usuário cancelou o seletor de arquivo
    } catch (err) {
      if (this.isAbort(err)) this.renderIdle();
      else this.renderError(err);
    } finally {
      this.abortController = null;
    }
  }

  // ---------- REVIEW ----------
  private renderReview(): void {
    this.clear();
    this.statusEl = null;
    const proposal = this.proposal;
    if (!proposal) return this.renderIdle();

    if (!proposal.cuts.length && !proposal.markers.length) {
      this.root.appendChild(
        make("div", { class: "pad" }, [
          make("h1", { text: "AutoCut" }),
          make("p", { class: "sub", text: "Nada para cortar nem marcadores falados encontrados nestes clips." }),
          make("div", { class: "row" }, [
            make("button", { class: "full", text: "Voltar", onclick: () => this.renderIdle() }),
          ]),
        ]),
      );
      return;
    }

    this.headInfo = make("div", { class: "summary" });
    this.applyBtn = make("button", { class: "apply", text: "" }) as HTMLButtonElement;

    // TOPO (gruda no alto ao rolar): título + fonte + resumo vivo.
    const fonte = proposal.source === "selection" ? "seleção" : "sequência inteira";
    this.root.appendChild(
      make("div", { class: "review-top" }, [
        make("div", { class: "review-head" }, [
          make("span", { class: "big", text: "Revisão" }),
          make("span", { class: "src", text: `${proposal.segments.length} clip(s) · ${fonte}` }),
        ]),
        this.headInfo,
      ]),
    );

    // CORPO ROLÁVEL (rola junto com o painel inteiro): segmentação + cortes finos.
    const body = make("div", { class: "review-body" });
    this.segBox = make("div", { class: "seg" });
    this.fillSegmentation();
    body.appendChild(this.segBox);
    if (proposal.cuts.length) body.appendChild(this.buildFineCutsSection());
    this.root.appendChild(body);

    // BARRA DE AÇÃO FIXA embaixo — sempre alcançável, em qualquer altura de janela.
    this.applyBtn.addEventListener("click", () => void this.runApply());
    this.root.appendChild(
      make("div", { class: "actions" }, [
        make("button", { class: "secondary", text: "Cancelar", onclick: () => this.renderIdle() }),
        this.applyBtn,
      ]),
    );

    this.updateSummary();
  }

  /** Seção COLAPSÁVEL de cortes finos (silêncio/filler) — recolhida por padrão (são centenas). */
  private buildFineCutsSection(): HTMLElement {
    const proposal = this.proposal;
    if (!proposal) return make("div");
    const section = make("div", { class: "section collapsed" });
    const head = make(
      "div",
      { class: "section-head clickable", onclick: () => section.classList.toggle("collapsed") },
      [
        make("span", { class: "chev", text: "▾" }),
        make("span", { class: "section-title", text: "Cortes finos · silêncio + filler" }),
        make("span", { class: "chip-count", text: String(proposal.cuts.length) }),
      ],
    );
    const bodyEl = make("div", { class: "section-body" });

    const nPerigo = this.impacts.filter((imp) => isDangerousCut(imp)).length;
    if (nPerigo > 0) {
      bodyEl.appendChild(
        make("div", { class: "danger-banner" }, [
          make("span", {
            text: `⚠ ${nPerigo} corte(s) apagariam um clipe inteiro — vieram DESMARCADOS por segurança. Marque só se quiser mesmo descartar o take.`,
          }),
        ]),
      );
    }
    const list = make("div", { class: "rows" });
    proposal.cuts.forEach((cut, i) =>
      list.appendChild(this.buildCutRow(cut, i, () => this.updateSummary())),
    );
    bodyEl.appendChild(list);

    section.appendChild(head);
    section.appendChild(bodyEl);
    return section;
  }

  /** Blocos confirmados (marcadores marcados) → janelas de tempo que viram sequências. */
  private currentBlocks(): Block[] {
    const proposal = this.proposal;
    if (!proposal) return [];
    const markers = proposal.markers.filter((_, i) => this.markerOn[i]);
    return buildBlocks(markers, proposal.durationSec);
  }

  /** Sinais de retake habilitados (take ruim a descartar). */
  private enabledSignals(): RetakeSignal[] {
    const proposal = this.proposal;
    if (!proposal) return [];
    return proposal.retakeSignals.filter((_, i) => this.signalOn[i]);
  }

  /** Palavras ao redor de um índice de palavra — pro humano reconhecer o marcador/retake. */
  private contextAt(wordIndex: number, before: number, after: number): string {
    const words = this.proposal?.transcript.words ?? [];
    const a = Math.max(0, wordIndex - before);
    const b = Math.min(words.length, wordIndex + after + 1);
    const txt = words.slice(a, b).map((w) => w.word).join(" ").trim();
    return txt.length > 80 ? txt.slice(0, 80).trimEnd() + "…" : txt;
  }

  /** (Re)constrói a seção de segmentação sem mexer na lista pesada de cortes finos. */
  private fillSegmentation(): void {
    const box = this.segBox;
    const proposal = this.proposal;
    if (!box || !proposal) return;
    while (box.firstChild) box.removeChild(box.firstChild);

    // ---- Blocos ----
    const blocks = this.currentBlocks();
    const blocosSec = make("div", { class: "section" }, [
      make("div", { class: "section-head" }, [
        make("span", { class: "section-title", text: "Blocos" }),
        make("span", { class: "chip-count", text: `${blocks.length} seq` }),
      ]),
    ]);
    if (!proposal.markers.length) {
      blocosSec.appendChild(
        make("p", { class: "section-desc", text: "Nenhum marcador falado detectado — vai sair 1 sequência só, com tudo." }),
      );
    } else {
      blocosSec.appendChild(
        make("p", { class: "section-desc", text: "Cada bloco marcado vira uma sequência nova. Confirme as fronteiras." }),
      );
      const list = make("div", { class: "rows" });
      proposal.markers.forEach((m, i) => list.appendChild(this.buildMarkerRow(m, i)));
      blocosSec.appendChild(list);
    }
    box.appendChild(blocosSec);

    // ---- Retakes ----
    if (proposal.retakeSignals.length) {
      const n = this.signalOn.filter(Boolean).length;
      const retSec = make("div", { class: "section" }, [
        make("div", { class: "section-head" }, [
          make("span", { class: "section-title", text: "Retakes" }),
          make("span", { class: "chip-count", text: `${n}/${proposal.retakeSignals.length}` }),
        ]),
        make("p", {
          class: "section-desc",
          text: 'O chefe avisa quando refaz ("vou ler de novo"). Marcado = descarta o take antes do aviso.',
        }),
      ]);
      const list = make("div", { class: "rows" });
      proposal.retakeSignals.forEach((s, i) => list.appendChild(this.buildSignalRow(s, i)));
      retSec.appendChild(list);
      box.appendChild(retSec);
    }
  }

  private buildMarkerRow(m: Marker, i: number): HTMLElement {
    const checkbox = make("input", { type: "checkbox", checked: this.markerOn[i] }) as HTMLInputElement;
    const ctx = this.contextAt(m.wordIndex, 1, 5);
    const meta: (Node | string)[] = [
      make("div", { class: "line1" }, [
        make("span", { class: "title", text: m.label }),
        make("span", { class: `cf ${m.confidence}`, text: m.confidence }),
        make("span", { class: "time", text: formatTime(m.startSec) }),
      ]),
    ];
    if (ctx) meta.push(make("div", { class: "ctx", text: `"${ctx}"` }));
    const row = make("div", { class: "item" + (this.markerOn[i] ? "" : " off") }, [
      checkbox,
      make("div", { class: "meta" }, meta),
    ]);
    // Clique na LINHA toda alterna (o checkbox é só indicador). fillSegmentation reconstrói.
    row.addEventListener("click", () => {
      this.markerOn[i] = !this.markerOn[i];
      this.fillSegmentation(); // contagem de blocos e janelas de retake mudam
      this.updateSummary();
    });
    return row;
  }

  private buildSignalRow(s: RetakeSignal, i: number): HTMLElement {
    const checkbox = make("input", { type: "checkbox", checked: this.signalOn[i] }) as HTMLInputElement;
    const blocks = this.currentBlocks();
    const block = blocks.find((b) => s.startSec >= b.startSec && s.startSec < b.endSec);
    const ctx = this.contextAt(s.wordIndex, 2, 5);
    const meta: (Node | string)[] = [
      make("div", { class: "line1" }, [
        make("span", { class: "title", text: `🔁 ${s.phrase}` }),
        make("span", { class: `cf ${s.confidence}`, text: s.confidence }),
        make("span", { class: "time", text: formatTime(s.startSec) }),
      ]),
    ];
    if (block) meta.push(make("div", { class: "note", text: `bloco: ${block.label}` }));
    if (ctx) meta.push(make("div", { class: "ctx", text: `"${ctx}"` }));
    const row = make("div", { class: "item" + (this.signalOn[i] ? "" : " off") }, [
      checkbox,
      make("div", { class: "meta" }, meta),
    ]);
    row.addEventListener("click", () => {
      this.signalOn[i] = !this.signalOn[i];
      this.fillSegmentation();
      this.updateSummary();
    });
    return row;
  }

  /** Atualiza o resumo do topo + o rótulo do botão Aplicar (sem re-render pesado). */
  private updateSummary(): void {
    const proposal = this.proposal;
    if (!proposal || !this.headInfo || !this.applyBtn) return;
    const blocks = this.currentBlocks();
    const fineN = this.enabled.filter(Boolean).length;
    const fineRemoved = proposal.cuts.reduce(
      (acc, c, i) => acc + (this.enabled[i] ? c.end - c.start : 0),
      0,
    );
    const enabledSignals = this.enabledSignals();
    let retakeRemoved = 0;
    for (const b of blocks) {
      const c = retakeCutForBlock(b, enabledSignals);
      if (c) retakeRemoved += c.end - c.start;
    }
    this.headInfo.textContent = `${blocks.length} sequência(s) · ${fineN} corte(s) finos (−${fineRemoved.toFixed(1)}s) · ${enabledSignals.length} retake(s) (−${retakeRemoved.toFixed(1)}s)`;
    this.applyBtn.textContent = blocks.length ? `Criar ${blocks.length} sequência(s)` : "Nada para criar";
    this.applyBtn.disabled = blocks.length === 0;
  }

  /** Palavras transcritas que este corte vai remover — pra revisão clara do QUE sai. */
  private cutWords(cut: Cut): string {
    const words = this.proposal?.transcript.words ?? [];
    const dentro = words.filter((w) => w.start < cut.end && w.end > cut.start).map((w) => w.word);
    if (!dentro.length) return "";
    const txt = dentro.join(" ");
    return txt.length > 90 ? txt.slice(0, 90).trimEnd() + "…" : txt;
  }

  private buildCutRow(cut: Cut, i: number, onToggle: () => void): HTMLElement {
    const danger = isDangerousCut(this.impacts[i]);
    const cls = () => "item" + (this.enabled[i] ? "" : " off") + (danger ? " danger" : "");

    const checkbox = make("input", {
      type: "checkbox",
      checked: this.enabled[i],
    }) as HTMLInputElement;

    const state = make("span", { class: "state" });
    const setState = () => {
      state.textContent = this.enabled[i] ? "✂ CORTAR" : "✓ MANTER";
      state.className = "state " + (this.enabled[i] ? "cutting" : "keeping");
    };
    setState();

    const meta: (Node | string)[] = [
      make("div", { class: "line1" }, [
        state,
        make("span", { class: `badge ${cut.reason}`, text: REASON_LABEL[cut.reason] }),
        make("span", { class: "time", text: `${formatTime(cut.start)} – ${formatTime(cut.end)}` }),
      ]),
    ];
    if (danger) {
      const imp = this.impacts[i];
      meta.push(
        make("div", {
          class: "warn",
          text: `⚠ apaga ${Math.round(imp.maxCoverage * 100)}% de um clipe inteiro (${imp.removedSec.toFixed(0)}s)`,
        }),
      );
    }
    const palavras = this.cutWords(cut);
    if (palavras) meta.push(make("div", { class: "ctx", text: `"${palavras}"` }));
    if (cut.detail) meta.push(make("div", { class: "note", text: cut.detail }));

    const row = make("div", { class: cls() }, [checkbox, make("div", { class: "meta" }, meta)]);

    // Clique na LINHA toda (a lista de cortes finos NÃO é reconstruída, então atualizo inline).
    row.addEventListener("click", () => {
      this.enabled[i] = !this.enabled[i];
      checkbox.checked = this.enabled[i];
      row.className = cls();
      setState();
      onToggle();
    });

    return row;
  }

  private async runApply(): Promise<void> {
    const proposal = this.proposal;
    if (!proposal) return;
    const blocks = this.currentBlocks();
    const approvedFine: Cut[] = proposal.cuts.filter((_, i) => this.enabled[i]);
    const enabledSignals = this.enabledSignals();
    this.renderBusy(`Montando ${blocks.length} sequência(s)…`);
    try {
      const names = await applyBlockSequences(
        this.client,
        proposal,
        blocks,
        approvedFine,
        enabledSignals,
        this.setStatus,
        RESPIRO[this.respiro],
      );
      const lista = names.length <= 6 ? `: ${names.join(", ")}` : "";
      this.renderDone(`Pronto! ${names.length} sequência(s) criada(s)${lista}.`);
    } catch (err) {
      this.renderError(err);
    }
  }

  // ---------- ZOOM REVIEW ----------
  private renderZoomReview(): void {
    this.clear();
    this.statusEl = null;
    const proposal = this.proposal;
    if (!proposal) return this.renderIdle();

    if (!proposal.zoomPoints.length) {
      this.root.appendChild(
        make("div", { class: "pad" }, [
          make("h1", { text: "Auto-Zoom" }),
          make("p", { class: "sub", text: "Nenhuma ponta de interesse encontrada pra zoom nesta transcrição." }),
          make("div", { class: "row" }, [
            make("button", { class: "full", text: "Voltar", onclick: () => this.renderIdle() }),
          ]),
        ]),
      );
      return;
    }

    this.headInfo = make("div", { class: "summary" });
    this.applyBtn = make("button", { class: "apply", text: "" }) as HTMLButtonElement;

    const fonte = proposal.source === "selection" ? "seleção" : "sequência inteira";
    this.root.appendChild(
      make("div", { class: "review-top" }, [
        make("div", { class: "review-head" }, [
          make("span", { class: "big", text: "Auto-Zoom" }),
          make("span", { class: "src", text: `${proposal.segments.length} clip(s) · ${fonte}` }),
        ]),
        this.headInfo,
      ]),
    );

    const body = make("div", { class: "review-body" });
    body.appendChild(
      make("p", { class: "section-desc", text: "Punch-in sutil (escala até 110) nas ênfases. Marque os que quer." }),
    );
    const list = make("div", { class: "rows" });
    proposal.zoomPoints.forEach((z, i) => list.appendChild(this.buildZoomRow(z, i)));
    body.appendChild(list);
    this.root.appendChild(body);

    this.applyBtn.addEventListener("click", () => void this.runApplyZooms());
    this.root.appendChild(
      make("div", { class: "actions" }, [
        make("button", { class: "secondary", text: "Cancelar", onclick: () => this.renderIdle() }),
        this.applyBtn,
      ]),
    );
    this.updateZoomSummary();
  }

  private buildZoomRow(z: ZoomPoint, i: number): HTMLElement {
    const checkbox = make("input", { type: "checkbox", checked: this.zoomOn[i] }) as HTMLInputElement;
    const peak = Math.max(...z.keys.map((k) => k.scale));
    const styleLabel = z.style === "punch" ? "Punch" : "Push";
    const trigLabel = z.trigger === "numero" ? "número" : z.trigger === "pergunta" ? "pergunta" : "ideia";
    const meta: (Node | string)[] = [
      make("div", { class: "line1" }, [
        make("span", { class: "title", text: `⤢ ${styleLabel} ${Math.round(peak)}%` }),
        make("span", { class: `cf ${z.confidence}`, text: trigLabel }),
        make("span", { class: "time", text: formatTime(z.startSec) }),
      ]),
    ];
    if (z.word) meta.push(make("div", { class: "ctx", text: `"${z.word}"` }));
    const row = make("div", { class: "item" + (this.zoomOn[i] ? "" : " off") }, [
      checkbox,
      make("div", { class: "meta" }, meta),
    ]);
    row.addEventListener("click", () => {
      this.zoomOn[i] = !this.zoomOn[i];
      checkbox.checked = this.zoomOn[i];
      row.className = "item" + (this.zoomOn[i] ? "" : " off");
      this.updateZoomSummary();
    });
    return row;
  }

  private updateZoomSummary(): void {
    const proposal = this.proposal;
    if (!proposal || !this.headInfo || !this.applyBtn) return;
    const enabled = proposal.zoomPoints.filter((_, i) => this.zoomOn[i]);
    const s = summarizeZooms(enabled);
    this.headInfo.textContent = `${s.total} zoom(s) · ${s.punch} punch · ${s.push} push`;
    this.applyBtn.textContent = s.total ? `Aplicar ${s.total} zoom(s)` : "Nada selecionado";
    this.applyBtn.disabled = s.total === 0;
  }

  private async runApplyZooms(): Promise<void> {
    const proposal = this.proposal;
    if (!proposal) return;
    const approved = proposal.zoomPoints.filter((_, i) => this.zoomOn[i]);
    this.renderBusy("Aplicando zoom…");
    try {
      const { applied, diag } = await applyZoomPoints(this.client, proposal, approved, this.setStatus);
      if (applied === 0) {
        // Mostra o diagnóstico NA TELA (o canal /debug pode não chegar durante o apply).
        this.renderZoomDiag(diag, approved.length);
      } else {
        this.renderDone(`Pronto! Zoom aplicado em ${applied} clip(s).`);
      }
    } catch (err) {
      this.renderError(err);
    }
  }

  /** Tela de diagnóstico do Auto-Zoom — o usuário tira um print e eu calibro com os dados reais. */
  private renderZoomDiag(diag: Array<{ label: string; data: unknown }>, approved: number): void {
    this.clear();
    this.statusEl = null;
    const text = diag.length
      ? diag.map((e) => `[${e.label}] ${JSON.stringify(e.data)}`).join("\n\n")
      : "(nenhum evento — o apply nem começou)";
    this.root.appendChild(
      make("div", { class: "pad" }, [
        make("h1", { text: "Auto-Zoom — diagnóstico" }),
        make("p", {
          class: "sub",
          text: `Rodou em ${approved} zoom(s) mas não aplicou em nenhum clip. Tira um print desta tela:`,
        }),
        make("pre", { class: "diag", text }),
        make("div", { class: "row" }, [
          make("button", { class: "full", text: "Voltar", onclick: () => this.renderIdle() }),
        ]),
      ]),
    );
  }

  // ---------- EDITOR POR TEXTO ----------
  private renderTextEditor(): void {
    this.clear();
    this.statusEl = null;
    const proposal = this.proposal;
    if (!proposal) return this.renderIdle();
    const words = proposal.transcript.words;

    if (!words.length) {
      this.root.appendChild(
        make("div", { class: "pad" }, [
          make("h1", { text: "Editar por texto" }),
          make("p", { class: "sub", text: "Sem transcrição pra editar nestes clips." }),
          make("div", { class: "row" }, [
            make("button", { class: "full", text: "Voltar", onclick: () => this.renderIdle() }),
          ]),
        ]),
      );
      return;
    }

    this.headInfo = make("div", { class: "summary" });
    this.applyBtn = make("button", { class: "apply", text: "" }) as HTMLButtonElement;

    // TOPO (gruda no alto): título + resumo vivo + toggle de silêncio + dica curta.
    const silToggle = make("input", { type: "checkbox", checked: this.removeSilence }) as HTMLInputElement;
    silToggle.addEventListener("change", () => {
      this.removeSilence = silToggle.checked;
      this.updateTextSummary();
    });
    this.syncNoteEl = make("p", { class: "te-sync", text: "Lendo a timeline…" });
    const top = make("div", { class: "review-top" }, [
      make("div", { class: "review-head" }, [make("span", { class: "big", text: "Editar por texto" })]),
      this.headInfo,
      make("label", { class: "sil-toggle" }, [
        silToggle,
        make("span", { text: "Remover silêncios e respiros junto" }),
      ]),
      make("p", {
        class: "te-hint",
        text: "Clique numa palavra pra remover · Shift+clique pra um trecho · clique de novo traz de volta.",
      }),
      this.syncNoteEl,
    ]);

    // CORPO ROLÁVEL: transcrição como TEXTO CORRIDO clicável.
    const body = make("div", { class: "review-body" });
    const tx = make("div", { class: "transcript" });
    this.wordSpans = [];
    words.forEach((w, i) => {
      const span = make("span", { class: "tw" + (this.wordDel[i] ? " del" : ""), text: w.word.trim() });
      span.addEventListener("click", (e: Event) => this.onWordClick(i, e as MouseEvent));
      this.wordSpans.push(span);
      tx.appendChild(span);
      tx.appendChild(document.createTextNode(" ")); // respiro visual entre palavras
    });
    body.appendChild(tx);

    // BARRA DE AÇÃO (rodapé do shell).
    this.applyBtn.addEventListener("click", () => void this.runApplyTextEdit());
    const actions = make("div", { class: "actions" }, [
      make("button", { class: "secondary", text: "Cancelar", onclick: () => this.renderIdle() }),
      this.applyBtn,
    ]);

    // APP-SHELL em flex: cabeçalho fixo no topo (em fluxo, opaco), transcrição rola SÓ no meio,
    // barra fixa embaixo. Sem position:sticky/fixed (instável no UXP, causava o menu por cima do texto).
    this.root.appendChild(make("div", { class: "te-shell" }, [top, body, actions]));

    this.updateTextSummary();
    this.startTextSync(); // espelha a timeline no texto, ao vivo
  }

  // ---------- SYNC AO VIVO: timeline → texto ----------
  // Enquanto o editor por texto está aberto, relê a sequência ATIVA a cada ~2s. Quando a
  // timeline muda (você cortou/aparou um clipe), as palavras correspondentes são riscadas/
  // restauradas sozinhas. A timeline é a fonte da verdade quando há um corte de verdade.

  private startTextSync(): void {
    this.stopTextSync();
    this.textSyncSig = "__init__";
    void (async () => {
      await this.syncTextFromTimeline(true);
      if (this.mode === "text") this.scheduleTextSync();
    })();
  }

  private scheduleTextSync(): void {
    // setTimeout recursivo (não setInterval): a próxima leitura só agenda depois desta terminar,
    // então nunca há duas leituras da timeline sobrepostas.
    this.textSyncTimer = setTimeout(async () => {
      if (this.mode !== "text" || !this.proposal) return this.stopTextSync();
      await this.syncTextFromTimeline(false);
      if (this.mode === "text") this.scheduleTextSync();
    }, 2000);
  }

  private stopTextSync(): void {
    if (this.textSyncTimer != null) {
      clearTimeout(this.textSyncTimer);
      this.textSyncTimer = null;
    }
  }

  private setSyncNote(msg: string): void {
    if (this.syncNoteEl) this.syncNoteEl.textContent = msg;
  }

  /**
   * Mapa por palavra: tempo de ORIGEM (midpoint) + caminho da mídia do segmento dono.
   * Converte o tempo ACHATADO da transcrição → tempo na mídia de origem (inSec do segmento +
   * offset relativo), pra cruzar com os in/out dos clipes que sobraram na timeline.
   */
  private buildWordSourceMap(): Array<{ mediaPath: string; sourceMid: number }> | null {
    const p = this.proposal;
    if (!p) return null;
    const segs = p.segments;
    const laid = layoutSegments(
      segs.map((s) => ({ flatDurSec: s.audio.clipRef.outSec - s.audio.clipRef.inSec })),
    ).laid;
    if (!laid.length) return null;
    return p.transcript.words.map((w) => {
      const mid = (w.start + w.end) / 2;
      let si = laid.findIndex((l) => mid >= l.flatStart && mid < l.flatEnd);
      if (si < 0) si = mid < laid[0].flatStart ? 0 : laid.length - 1; // clamp nas bordas
      const seg = segs[si];
      return { mediaPath: seg.audio.clipRef.mediaPath, sourceMid: seg.audio.clipRef.inSec + (mid - laid[si].flatStart) };
    });
  }

  private async syncTextFromTimeline(isFirst: boolean): Promise<void> {
    if (this.mode !== "text" || !this.proposal) return;
    // Leitura BARATA (só in/out) pra detectar mudança sem resolver a mídia de cada clipe.
    let light: TimelineAudioSpan[];
    try {
      light = await readTimelineAudioSpans(false);
    } catch {
      return; // sequência fechada/sem acesso — tenta de novo no próximo tick
    }
    const sig = light.map((s) => `${s.inSec.toFixed(3)}|${s.outSec.toFixed(3)}`).sort().join("~");
    if (!isFirst && sig === this.textSyncSig) return; // timeline igual → não atropela cliques manuais
    const firstEstablish = this.textSyncSig === "__init__";
    this.textSyncSig = sig;

    // Mudou (ou 1ª leitura): agora resolve os caminhos e cruza com as palavras.
    const wmap = this.buildWordSourceMap();
    if (!wmap) return;
    let spans: TimelineAudioSpan[];
    try {
      spans = await readTimelineAudioSpans(true);
    } catch {
      return;
    }
    const paths = new Set(this.proposal.segments.map((s) => s.audio.clipRef.mediaPath));
    const matched = spans.filter((s) => paths.has(s.mediaPath));
    if (!matched.length) {
      this.setSyncNote("a sequência ativa não é desta transcrição — abra o rough cut pra espelhar");
      return;
    }

    const EPS = 0.02; // ~meio frame de tolerância na fronteira
    const covered = (w: { mediaPath: string; sourceMid: number }): boolean =>
      matched.some((m) => m.mediaPath === w.mediaPath && w.sourceMid >= m.inSec - EPS && w.sourceMid <= m.outSec + EPS);

    // Na 1ª leitura, se a timeline ainda contém ~tudo (sequência de ORIGEM, sem cortes), NÃO
    // sobrescreve as sugestões automáticas — só espelha quando já existe um corte de verdade.
    if (firstEstablish) {
      const cov = wmap.filter(covered).length / wmap.length;
      if (cov > 0.97) {
        this.setSyncNote("sequência completa (sem cortes) — sugestões mantidas");
        return;
      }
    }

    // Espelha: palavra presente na timeline = mantida; ausente = riscada.
    let changed = 0;
    for (let i = 0; i < wmap.length; i++) {
      const del = !covered(wmap[i]);
      if (this.wordDel[i] !== del) {
        this.setWordDel(i, del);
        changed++;
      }
    }
    this.updateTextSummary();
    this.setSyncNote(`espelhando a timeline · ${matched.length} clipe(s)${changed ? ` · ${changed} atualizada(s)` : ""}`);
  }

  /** Clique numa palavra: alterna remover/manter. Shift+clique: aplica ao trecho do último clique. */
  private onWordClick(i: number, e: MouseEvent): void {
    if (e.shiftKey && this.lastWordClick >= 0 && this.lastWordClick < this.wordDel.length) {
      const a = Math.min(this.lastWordClick, i);
      const b = Math.max(this.lastWordClick, i);
      const alvo = !this.wordDel[i]; // estado-alvo do trecho = oposto do estado atual desta palavra
      for (let k = a; k <= b; k++) this.setWordDel(k, alvo);
    } else {
      this.setWordDel(i, !this.wordDel[i]);
    }
    this.lastWordClick = i;
    this.updateTextSummary();
  }

  private setWordDel(i: number, del: boolean): void {
    this.wordDel[i] = del;
    const span = this.wordSpans[i];
    if (span) span.className = "tw" + (del ? " del" : "");
  }

  /** Resumo vivo (palavras removidas + duração final estimada) + rótulo do botão. */
  private updateTextSummary(): void {
    const proposal = this.proposal;
    if (!proposal || !this.headInfo || !this.applyBtn) return;
    const words = proposal.transcript.words;
    let removedSec = 0;
    let nRemoved = 0;
    for (let i = 0; i < words.length; i++) {
      if (this.wordDel[i]) {
        removedSec += words[i].end - words[i].start;
        nRemoved++;
      }
    }
    const silSec = this.removeSilence
      ? proposal.cuts.filter((c) => c.reason === "silencio").reduce((a, c) => a + (c.end - c.start), 0)
      : 0;
    const finalSec = Math.max(0, proposal.durationSec - removedSec - silSec);
    this.headInfo.textContent = `${nRemoved} palavra(s) removida(s) · vídeo final ~${finalSec.toFixed(1)}s`;
    this.applyBtn.textContent = nRemoved || silSec ? "Criar corte" : "Nada removido";
    this.applyBtn.disabled = nRemoved === 0 && silSec === 0;
  }

  private async runApplyTextEdit(): Promise<void> {
    const proposal = this.proposal;
    if (!proposal) return;
    const words = proposal.transcript.words;
    // Runs de palavras removidas contíguas → uma faixa de corte cada. reason "bad_take" = remoção
    // TOTAL (sem pad) — tira a palavra inteira; o motor é o mesmo do Auto-Edit (mesmo acabamento).
    const wordCuts: Cut[] = [];
    let i = 0;
    while (i < words.length) {
      if (!this.wordDel[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < words.length && this.wordDel[j + 1]) j++;
      wordCuts.push({ start: words[i].start, end: words[j].end, reason: "bad_take", detail: "removido no texto" });
      i = j + 1;
    }
    const silenceCuts = this.removeSilence
      ? proposal.cuts.filter((c) => c.reason === "silencio")
      : [];
    const allCuts = [...silenceCuts, ...wordCuts];
    if (!allCuts.length) return;

    this.renderBusy("Montando o corte na timeline…");
    try {
      const seqName = await applyApprovedCuts(this.client, proposal, allCuts, this.setStatus, RESPIRO[this.respiro]);
      this.renderDone(
        `Pronto! Sequência "${seqName}" criada — ${wordCuts.length} trecho(s) removido(s) por texto.`,
      );
    } catch (err) {
      this.renderError(err);
    }
  }

  // ---------- DONE / ERROR ----------
  private renderDone(msg: string): void {
    this.clear();
    this.statusEl = null;
    this.root.appendChild(
      make("div", { class: "pad" }, [
        make("h1", { text: "AutoCut" }),
        make("p", { class: "status", text: msg }),
        make("div", { class: "row" }, [
          make("button", { class: "full", text: "Novo Auto-Edit", onclick: () => this.renderIdle() }),
        ]),
      ]),
    );
  }

  private renderError(err: unknown): void {
    this.clear();
    this.statusEl = null;
    const msg = err instanceof Error ? err.message : String(err);
    this.root.appendChild(
      make("div", { class: "pad" }, [
        make("h1", { text: "AutoCut" }),
        make("p", { class: "error", text: msg }),
        make("div", { class: "row" }, [
          make("button", {
            class: "secondary full",
            text: "Tentar de novo",
            onclick: () =>
              this.proposal
                ? this.mode === "zoom"
                  ? this.renderZoomReview()
                  : this.mode === "text"
                    ? this.renderTextEditor()
                    : this.renderReview()
                : this.renderIdle(),
          }),
        ]),
      ]),
    );
  }
}
