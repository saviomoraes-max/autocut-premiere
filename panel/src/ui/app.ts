// Controlador do painel (vanilla DOM — sem innerHTML, compatível com o subset do UXP).
//
// Redesign "1a Quieto" (handoff de 21/09/2026): o painel virou três etapas explícitas —
// Configurar → Processar → Revisar — mais as telas de apoio (Editar por texto, Auto-Zoom,
// Exportar SRT, Config, Erro, Vazio). A LÓGICA é a mesma de antes (proposta, trava de corte
// perigoso, blocos por marcador, sincronia do editor por texto); o que mudou é a apresentação.
//
// O que o handoff marcou como dependente de backend que ainda não existe ficou de fora, como o
// próprio handoff pede: play do trecho, prévia ao vivo da transcrição, respiro por corte.
import { BackendClient, DEFAULT_BASE_URL, type BackendConfig, type HealthResponse } from "../api/backendClient";
import {
  proposeCuts,
  applyApprovedCuts,
  applyBlockSequences,
  applyZoomPoints,
  exportSrt,
  type Proposal,
} from "../state/autoedit";
import { layoutSegments, assessCutsClipImpact, isDangerousCut, type CutClipImpact } from "../../../shared/segments";
import { buildBlocks, retakeCutForBlock, type Block } from "../../../shared/blocks";
import {
  readTimelineAudioSpans,
  readSourceSummary,
  sourceSignature,
  type SourceSummary,
  type TimelineAudioSpan,
} from "../premiere/selection";
import type { CaptionStyle, Cut, Marker, RetakeSignal, ZoomPoint } from "../../../shared/types";
import {
  make,
  clearChildren,
  fmtClock,
  fmtTc,
  fmtDec,
  unionLength,
  riscar,
  btn,
  link,
  type Botao,
  check,
  setCheck,
  chip,
  stepper,
  durCounter,
  segmented,
  numStepper,
  optRow,
  screen,
  footer,
  animarProcesso,
} from "./kit";

let mounted = false;

export function mountApp(root: HTMLElement): void {
  if (mounted) return;
  mounted = true;
  new PanelController(root);
}

/**
 * Presets de RESPIRO: quanto de pausa sobra em volta de cada corte + qual pausa mínima vira
 * corte. "Natural" = comportamento validado atual (não mudar sem re-auditar). "Seco" corta mais
 * rente (reel dinâmico — pode encostar no decay da fala, escolha editorial). "Suave" respira
 * mais (VSL calmo). Medição 2026-07-16 (RLS004 + bruto SEM27): o detector acha 95%+ das pausas;
 * o gap que sobra no vídeo é ESTA margem — por isso ela é o botão, não o detector.
 */
type RespiroPreset = "seco" | "natural" | "suave";
/**
 * 23/set/2026: startSec/endSec deixaram de ser um encolhimento FIXO do corte e viraram o PISO do
 * respiro — o backend mede no áudio onde a voz realmente acabou (2ª passada do silencedetect) e
 * usa o maior entre a medida e este piso. Medido no bruto de 93 min: o decaimento real dura 15–20
 * ms na mediana (139 ms no p90), enquanto o valor fixo de 0,12 s deixava ~0,34 s de ar em TODO
 * corte. Estes números também são a distância mínima entre um corte de fala e a palavra vizinha.
 */
const RESPIRO: Record<RespiroPreset, { startSec: number; endSec: number; minSilenceSec: number; label: string }> = {
  seco: { startSec: 0.03, endSec: 0.02, minSilenceSec: 0.25, label: "Seco" },
  natural: { startSec: 0.06, endSec: 0.05, minSilenceSec: 0.35, label: "Natural" },
  suave: { startSec: 0.12, endSec: 0.1, minSilenceSec: 0.45, label: "Suave" },
};

/**
 * ESTILO DA LEGENDA (Exportar SRT). As mesmas palavras transcritas, duas montagens:
 *   Reels  = dinâmica, 1 linha de 14 caracteres → na prática uma palavra por legenda.
 *   Cinema = a frase inteira legível, até 2 linhas de 42 caracteres (padrão de legendagem).
 * Quem aplica a diferença é o backend; aqui só se escolhe qual preset mandar.
 */
const ESTILO_LEGENDA: Record<CaptionStyle, string> = { reels: "Reels", cinema: "Cinema" };

/** Texto que cada atalho acrescenta às instruções. */
const ATALHOS_PROMPT = ["Corte agressivo", "Sem filler", "Manter as repetições"];

/** Rótulo curto do motivo de um corte (chip da lista de cortes finos). */
function rotuloMotivo(cut: Cut): string {
  switch (cut.reason) {
    case "silencio":
      return "silêncio";
    case "filler":
      return "filler";
    case "repeticao":
      return "repetição";
    case "comando":
      return "recado";
    default:
      if (cut.detail?.startsWith("falso começo")) return "falso começo";
      if (cut.detail?.includes("trecho refeito")) return "trecho refeito";
      return "bad take";
  }
}

/** Salva o .srt via SELETOR DE ARQUIVO do UXP (o usuário escolhe onde). null = cancelou.
 *  `nomeSugerido` já vem com o estilo no nome, pra um export não sobrescrever o outro. */
async function saveSrtFile(srt: string, nomeSugerido = "legendas.srt"): Promise<string | null> {
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
  const file = await fs.getFileForSaving(nomeSugerido, { types: ["srt"] });
  if (!file) return null; // usuário fechou o diálogo
  await file.write(srt);
  return file.name ?? nomeSugerido;
}

type Aba = "retakes" | "blocos" | "finos";
/** O que está rodando na tela Processar — decide rótulos, etapas e se dá pra cancelar. */
type ProcKind = "cut" | "zoom" | "text" | "srt" | "apply" | "applyZoom" | "applyText";
/** Onde o erro aconteceu: antes de mexer na timeline ou durante a montagem. */
type FaseErro = "antes" | "montagem";

class PanelController {
  private client = new BackendClient();
  private cfg: BackendConfig = { baseUrl: DEFAULT_BASE_URL, authToken: "" };
  private userPrompt = "";
  /** Ajuste de sincronia do SRT (s): >0 atrasa a legenda, <0 adianta. */
  private srtSyncSec = 0;
  /** Estilo da legenda no Exportar SRT: dinâmica de reels (padrão) ou de cinema. */
  private captionStyle: CaptionStyle = "reels";
  /** Preset de respiro dos cortes (Seco/Natural/Suave). Vale pro Auto-Edit e pro editor por texto. */
  private respiro: RespiroPreset = "natural";

  // Estado do backend (tela inicial, Processar e Config mostram a configuração REAL).
  private health: HealthResponse | null = null;
  private backendOk: boolean | null = null; // null = verificando

  // Fonte (sequência ativa) — lida ao abrir a home e reconferida a cada 2,5 s.
  private source: SourceSummary | null | undefined = undefined; // undefined = ainda não lida
  private sourceSig: string | null = null;
  private sourceErro = false;
  private homeTimer: ReturnType<typeof setTimeout> | null = null;
  private tela = "home";

  /** Aviso de conclusão mostrado na home depois de criar sequência / aplicar zoom / salvar SRT. */
  private notice: string | null = null;

  private proposal: Proposal | null = null;
  private enabled: boolean[] = [];
  private impacts: CutClipImpact[] = [];
  private markerOn: boolean[] = [];
  private signalOn: boolean[] = [];
  private zoomOn: boolean[] = [];
  private mode: "cut" | "zoom" | "text" = "cut";
  private aba: Aba = "retakes";

  // Editor por texto: por palavra, se está marcada pra REMOVER. + toggle global de silêncio.
  private wordDel: boolean[] = [];
  private removeSilence = true;
  private lastWordClick = -1; // pra shift+clique selecionar um trecho
  private wordSpans: HTMLElement[] = []; // os spans das palavras (atualização pontual)
  // Sync ao vivo timeline→texto: relê a sequência ativa e espelha os cortes no texto.
  private textSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private textSyncSig = ""; // assinatura (in/out dos clipes) da última leitura — detecta mudança
  private syncNoteEl: HTMLElement | null = null;

  /** Aborta a transcrição/análise em andamento (botão Cancelar). */
  private abortController: AbortController | null = null;
  private stopAnim: (() => void) | null = null;

  // Elementos atualizados no lugar (sem reconstruir a tela inteira).
  private statusEl: HTMLElement | null = null; // subtítulo da tela Processar
  private procTitle: HTMLElement | null = null;
  private procRows: HTMLElement[] = [];
  private procFill: HTMLElement | null = null;
  private tabCounts: HTMLElement[] = [];
  private promptNote: HTMLElement | null = null;
  private procKind: ProcKind = "cut";
  private cancelBtn: Botao | null = null;
  private listEl: HTMLElement | null = null;
  private ctxEl: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private dur: ReturnType<typeof durCounter> | null = null;
  private footText: HTMLElement | null = null;
  private applyBtn: Botao | null = null;
  private sourceCard: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private fineRowUpdaters: Array<() => void> = [];

  constructor(private root: HTMLElement) {
    // Gancho de desenvolvimento: panel/dev/uxp.mjs abre as telas com o bruto de teste e mede o
    // layout DENTRO do Premiere (o Chromium não reproduz o UXP). Não muda nada no uso normal.
    (globalThis as Record<string, unknown>).__autocutDev = this;
    this.renderHome();
  }

  private clear(): void {
    this.stopTextSync(); // sai do editor por texto → para o poll da timeline
    this.stopHomePoll();
    this.stopAnim?.();
    this.stopAnim = null;
    this.syncNoteEl = null;
    this.statusEl = null;
    this.procTitle = null;
    this.procRows = [];
    this.procFill = null;
    this.tabCounts = [];
    this.promptNote = null;
    this.cancelBtn = null;
    this.sourceCard = null;
    this.statusLine = null;
    this.fineRowUpdaters = [];
    clearChildren(this.root);
  }

  // =====================================================================
  // BACKEND
  // =====================================================================

  private refreshHealth(onDone?: () => void): void {
    this.backendOk = null;
    this.client.setConfig(this.cfg);
    this.client
      .health()
      .then((h) => {
        this.health = h;
        this.backendOk = true;
      })
      .catch(() => {
        this.backendOk = false;
      })
      .finally(() => {
        this.paintStatusLine();
        if (this.promptNote) {
          this.promptNote.className = `opt-sub prompt-note${this.health?.analyzer === "local" ? " on" : ""}`;
        }
        onDone?.();
      });
  }

  /** "elevenlabs · scribe_v2" */
  private motorLabel(): string {
    return this.health ? `${this.health.transcriber} · ${this.health.model}` : "—";
  }

  /** Rótulo da análise de cortes, pela configuração REAL do backend. */
  private analiseLabel(): string {
    const h = this.health;
    if (!h?.analyzer) return "—";
    if (h.analyzer === "anthropic") return [h.analyzerModel, h.analyzerEffort].filter(Boolean).join(" · ");
    if (h.analyzer === "ollama") return `ollama · ${h.analyzerModel ?? ""}`.trim();
    return "análise local · sem IA";
  }

  private statusRow(): HTMLElement {
    this.statusLine = make("div", { class: "status-line" });
    this.paintStatusLine();
    return make("div", { class: "status-row" }, [this.statusLine, link("Config", () => this.renderConfig())]);
  }

  private paintStatusLine(): void {
    const el = this.statusLine;
    if (!el) return;
    clearChildren(el);
    // texto num <span> próprio: nó de texto solto dentro de flex não quebra linha no UXP
    if (this.backendOk === null) {
      el.appendChild(make("div", { class: "dot" }));
      el.appendChild(make("span", { class: "status-text", text: "verificando o backend…" }));
    } else if (this.backendOk) {
      el.appendChild(make("div", { class: "dot ok" }));
      el.appendChild(make("span", { class: "status-text", text: `backend ok — ${this.health?.transcriber} (${this.health?.model})` }));
    } else {
      el.appendChild(make("div", { class: "dot off" }));
      el.appendChild(make("span", { class: "status-text", text: "backend fora do ar" }));
    }
  }

  // =====================================================================
  // FONTE (sequência ativa) — cartão da home + troca pra tela Vazio
  // =====================================================================

  private startHomePoll(): void {
    this.stopHomePoll();
    // setTimeout recursivo: a próxima leitura só agenda depois desta terminar (sem sobreposição).
    const tick = async () => {
      await this.checkSource();
      if (this.tela === "home" || this.tela === "vazio") this.homeTimer = setTimeout(tick, 2500);
    };
    void tick();
  }

  private stopHomePoll(): void {
    if (this.homeTimer != null) {
      clearTimeout(this.homeTimer);
      this.homeTimer = null;
    }
  }

  /** Relê a fonte só quando a assinatura barata muda; troca Home ↔ Vazio quando precisa. */
  private async checkSource(): Promise<void> {
    let sig: string | null;
    try {
      sig = await sourceSignature();
    } catch {
      this.sourceErro = true;
      this.paintSourceCard();
      return;
    }
    if (sig === null) {
      this.source = null;
      this.sourceSig = null;
      if (this.tela === "home") this.renderVazio();
      return;
    }
    if (sig === this.sourceSig && this.source) return;
    this.sourceSig = sig;
    try {
      this.source = await readSourceSummary();
      this.sourceErro = false;
    } catch {
      this.sourceErro = true;
    }
    if (this.tela === "vazio" && this.source) this.renderHome();
    else this.paintSourceCard();
  }

  private paintSourceCard(): void {
    const card = this.sourceCard;
    if (!card) return;
    clearChildren(card);
    const s = this.source;
    const esquerda = make("div", { class: "source-left" }, [make("div", { class: "label-mono", text: "FONTE" })]);
    const meta = make("div", { class: "source-meta" });
    if (this.sourceErro && !s) {
      esquerda.appendChild(make("div", { class: "source-name", text: "Não consegui ler a timeline" }));
    } else if (!s) {
      esquerda.appendChild(make("div", { class: "source-name", text: "Lendo a timeline…" }));
    } else {
      esquerda.appendChild(make("div", { class: "source-name", text: s.sequenceName }));
      const qtd =
        s.scope === "selection"
          ? `${s.clips} ${s.clips === 1 ? "clipe selecionado" : "clipes selecionados"}`
          : `${s.clips} ${s.clips === 1 ? "clipe" : "clipes"} na sequência`;
      meta.appendChild(make("div", { text: qtd }));
      meta.appendChild(make("div", { class: "src-dur", text: fmtClock(s.durationSec) }));
      meta.appendChild(make("div", { class: "hint-pill", text: "Nada selecionado = sequência inteira" }));
    }
    card.appendChild(esquerda);
    card.appendChild(meta);
  }

  // =====================================================================
  // 1. CONFIGURAR (home)
  // =====================================================================

  private renderHome(): void {
    this.clear();
    this.tela = "home";

    // O <textarea> é editor nativo desenhado por cima do CSS: sem borda nem respiro próprios, ele
    // ocupa a caixa `.field-box`, que é quem tem a borda arredondada do design.
    const promptField = make("textarea", {
      class: "field-input",
      placeholder: "Corte agressivo, remova pausas longas, mantenha o tom…",
      value: this.userPrompt,
      oninput: (e: Event) => {
        this.userPrompt = (e.target as HTMLTextAreaElement).value;
      },
    }) as HTMLTextAreaElement;
    const atalhos = make(
      "div",
      { class: "prompt-chips" },
      ATALHOS_PROMPT.map((t) =>
        make("div", {
          class: "pchip",
          role: "button",
          text: t,
          onclick: () => {
            const atual = this.userPrompt.trim();
            this.userPrompt = atual ? `${atual.replace(/[.,;]$/, "")}, ${t.toLowerCase()}` : t;
            promptField.value = this.userPrompt;
          },
        }),
      ),
    );
    const blocoPrompt = make("div", {}, [
      make("div", { class: "field-label", text: "Como você quer o corte?" }),
      make("div", { class: "field-box" }, [promptField]),
      make("div", { class: "prompt-chips-wrap" }, [atalhos]),
    ]);
    // Honestidade: com a análise LOCAL (padrão do backend) o texto não chega a mudar o corte —
    // só a análise com IA lê as instruções. O aviso aparece quando o /health confirma que é local.
    this.promptNote = make("div", {
      class: "opt-sub prompt-note",
      text: "Com a análise local (padrão), estas instruções não mudam o corte — só a análise com IA as lê.",
    });
    blocoPrompt.appendChild(this.promptNote);

    const opcoes = make("div", { class: "opt-list" }, [
      optRow(
        "Respiro dos cortes",
        segmented(
          (Object.keys(RESPIRO) as RespiroPreset[]).map((k) => ({ value: k, label: RESPIRO[k].label })),
          this.respiro,
          (v) => (this.respiro = v),
        ),
      ),
      optRow(
        "Estilo da legenda",
        segmented(
          (Object.keys(ESTILO_LEGENDA) as CaptionStyle[]).map((k) => ({ value: k, label: ESTILO_LEGENDA[k] })),
          this.captionStyle,
          (v) => (this.captionStyle = v),
        ),
      ),
      optRow("Sincronia da legenda", numStepper(this.srtSyncSec, 0.1, (v) => (this.srtSyncSec = v)), "+ atrasa · − adianta"),
    ]);

    const acoes = make("div", { class: "actions-row" }, [
      btn("Auto-Edit", "primary lg-primary", () => void this.runPropose("cut")),
      btn("Editar por texto", "sec", () => void this.runPropose("text")),
      btn("Auto-Zoom", "sec", () => void this.runPropose("zoom")),
      btn("SRT", "sec", () => this.renderSrt()),
    ]);

    this.sourceCard = make("div", { class: "card source-card" });
    this.paintSourceCard();

    const corpo = make("div", { class: "screen-body stack-40" }, [
      make("div", { class: "head-row" }, [
        make("div", { class: "title-block" }, [
          make("h1", { class: "h1", text: "Rough cut" }),
          make("div", { class: "sub", text: "Transcreve, remove respiros e retakes, devolve uma sequência limpa." }),
        ]),
        stepper(1),
      ]),
      this.notice ? this.noticeCard(this.notice) : null,
      this.sourceCard,
      blocoPrompt,
      opcoes,
      acoes,
      this.statusRow(),
    ]);
    this.root.appendChild(screen(corpo));
    this.refreshHealth();
    this.startHomePoll();
  }

  private noticeCard(msg: string): HTMLElement {
    return make("div", { class: "notice" }, [
      make("div", { class: "notice-text" }, [make("div", { class: "dot ok" }), make("span", { text: msg })]),
      link("Fechar", () => {
        this.notice = null;
        this.renderHome();
      }),
    ]);
  }

  // =====================================================================
  // 9. VAZIO
  // =====================================================================

  private renderVazio(): void {
    this.clear();
    this.tela = "vazio";
    const corpo = make("div", { class: "screen-body stack-26 pt-72 pb-72" }, [
      make("div", { class: "empty-mark" }),
      make("div", { class: "title-block" }, [
        make("h1", { class: "h1 sm", text: "Nenhuma sequência aberta" }),
        make("div", {
          class: "sub",
          style: "max-width: 560px",
          text: "Abra a sequência do bruto no Premiere. Selecione os clipes que quer cortar — ou deixe nada selecionado e o AutoCut roda na sequência inteira.",
        }),
      ]),
      this.statusRow(),
    ]);
    this.root.appendChild(screen(corpo));
    this.refreshHealth();
    this.startHomePoll(); // abre a home sozinha quando uma sequência ficar ativa
  }

  // =====================================================================
  // 2. PROCESSAR
  // =====================================================================

  private renderProcessar(kind: ProcKind, onCancel?: () => void): void {
    this.clear();
    this.tela = "processar";
    this.procKind = kind;

    const montagem = kind === "apply" || kind === "applyZoom" || kind === "applyText";
    const eyebrow = montagem
      ? kind === "applyZoom"
        ? "APLICANDO O ZOOM"
        : "CRIANDO A SEQUÊNCIA"
      : "ETAPA 2 DE 3";
    this.procTitle = make("h1", { class: "h1 md", text: "Preparando" });
    this.statusEl = make("div", { class: "sub", text: "Iniciando…" });

    const fill = make("div", { class: "track-fill" });
    this.procFill = fill;
    const partes: (HTMLElement | null)[] = [
      make("div", { class: "title-block" }, [make("div", { class: "eyebrow", text: eyebrow }), this.procTitle, this.statusEl]),
      make("div", { class: "track" }, [fill]),
    ];

    // Etapas (só nos fluxos que transcrevem). A montagem do rough cut NÃO aparece aqui: ela só
    // acontece depois da revisão.
    if (!montagem) {
      const segunda =
        kind === "srt"
          ? { label: "Montando a legenda", meta: ESTILO_LEGENDA[this.captionStyle].toLowerCase() }
          : { label: "Analisando os cortes", meta: this.analiseLabel() };
      this.procRows = [
        this.procRow("Transcrevendo o áudio", this.motorLabel() + (kind === "srt" ? " · texto limpo" : "")),
        this.procRow(segunda.label, segunda.meta),
      ];
      partes.push(make("div", { class: "proc-list" }, this.procRows));
    }

    const nota = montagem
      ? kind === "applyZoom"
        ? "O zoom entra nos clipes da V1 da sequência aberta."
        : "A sequência original não é alterada: o AutoCut cria sequências novas."
      : kind === "srt"
        ? "Nada é alterado na timeline: a legenda sai num arquivo .srt."
        : kind === "zoom"
          ? "Nada é alterado na timeline: o zoom só entra depois que você aprova."
          : "Nada é alterado na timeline: o rough cut só é montado depois que você aprova.";
    const rodape = make("div", { class: "proc-foot" }, [make("div", { class: "note", text: nota })]);
    if (onCancel) {
      this.cancelBtn = btn("Cancelar", "md", onCancel);
      rodape.appendChild(this.cancelBtn);
    }
    partes.push(rodape);

    this.root.appendChild(screen(make("div", { class: "screen-body stack-40 pt-56" }, partes)));
    this.setProcStage("inicio");
  }

  private procRow(label: string, meta: string): HTMLElement {
    return make("div", { class: "proc-row queued" }, [
      make("div", { class: "proc-mark" }),
      make("div", { class: "proc-label", text: label }),
      make("div", { class: "proc-meta", text: meta }),
    ]);
  }

  /** Recebe o texto real de progresso (onStatus) — vira o subtítulo e decide a etapa ativa. */
  private setStatus = (msg: string): void => {
    if (this.statusEl) this.statusEl.textContent = msg;
    if (/^(Lendo|Relendo)/.test(msg)) this.setProcStage("ler");
    else if (/^Transcrevendo/.test(msg)) this.setProcStage("transcrever");
    else if (/^Analisando/.test(msg)) this.setProcStage("analisar");
    else if (/^Montando as legendas/.test(msg)) this.setProcStage("legenda");
    else if (/^Salvando/.test(msg)) this.setProcStage("salvar");
    else if (/^Aplicando/.test(msg)) this.setProcStage("aplicar");
    else if (/^Montando/.test(msg)) this.setProcStage("montar");
    else if (/^Cancelando/.test(msg)) this.setProcStage("cancelar");
  };

  private setProcStage(
    stage: "inicio" | "ler" | "transcrever" | "analisar" | "legenda" | "salvar" | "montar" | "aplicar" | "cancelar",
  ): void {
    const titulos: Record<string, string> = {
      inicio: "Preparando",
      ler: "Lendo a timeline",
      transcrever: "Transcrevendo",
      analisar: "Analisando",
      legenda: "Montando a legenda",
      salvar: "Salvando",
      montar: "Montando",
      aplicar: "Aplicando o zoom",
      cancelar: "Cancelando",
    };
    if (this.procTitle) this.procTitle.textContent = titulos[stage];
    if (stage === "cancelar" && this.cancelBtn) this.cancelBtn.disabled = true;
    const bolinhas: HTMLElement[] = [];
    if (this.procRows.length === 2) this.paintProcRows(stage, bolinhas);
    // (Re)inicia a animação da barra com as bolinhas da etapa ativa.
    this.stopAnim?.();
    this.stopAnim = animarProcesso(this.procFill, bolinhas);
  }

  /** Estado de cada etapa: fila → ativa (bolinha pulsando) → concluída (✓). */
  private paintProcRows(stage: string, bolinhas: HTMLElement[]): void {
    const passo1 = stage === "transcrever" ? "active" : ["analisar", "legenda", "salvar"].includes(stage) ? "done" : "queued";
    const passo2 = ["analisar", "legenda"].includes(stage) ? "active" : stage === "salvar" ? "done" : "queued";
    [passo1, passo2].forEach((estado, i) => {
      const row = this.procRows[i];
      row.className = `proc-row ${estado}`;
      const mark = row.firstChild as HTMLElement;
      clearChildren(mark);
      if (estado === "active") {
        const dot = make("div", { class: "dot proc-dot" }); // cor no CSS: a animação reescreve o style
        mark.appendChild(dot);
        bolinhas.push(dot);
      } else if (estado === "done") {
        mark.textContent = "✓";
      }
    });
  }

  private async runPropose(mode: "cut" | "zoom" | "text"): Promise<void> {
    this.mode = mode;
    this.notice = null;
    // Aborta qualquer transcrição anterior ainda viva — sem isto, clicar de novo deixava DOIS
    // transcritores rodando em paralelo no backend.
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.renderProcessar(mode, () => this.cancelPropose());
    try {
      this.client.setConfig(this.cfg);
      this.proposal = await proposeCuts(
        this.client,
        this.userPrompt || undefined,
        this.setStatus,
        this.abortController.signal,
        {
          minSilenceSec: RESPIRO[this.respiro].minSilenceSec,
          margemInicioSec: RESPIRO[this.respiro].startSec,
          margemFimSec: RESPIRO[this.respiro].endSec,
        },
      );
      this.receberProposta(mode);
    } catch (err) {
      // Cancelado pelo usuário → volta pro início, sem cara de erro.
      if (this.isAbort(err)) this.renderHome();
      else this.renderErro(err, "antes");
    } finally {
      this.abortController = null;
    }
  }

  /** Proposta pronta → estado inicial das marcações e a tela de revisão do modo. */
  private receberProposta(mode: "cut" | "zoom" | "text"): void {
    this.mode = mode;
    if (!this.proposal) return this.renderHome();
    if (mode === "zoom") {
      // Auto-Zoom: zoom de confiança ALTA já vem marcado; BAIXA (ideia fraca) desmarcado.
      this.zoomOn = this.proposal.zoomPoints.map((z) => z.confidence === "alta");
      this.renderZoom();
      return;
    }
    if (mode === "text") {
      // Editor por texto: muletas (filler/gagueira/falso começo) já vêm RISCADAS; silêncios via toggle.
      const words = this.proposal.transcript.words;
      const fillerRanges = this.proposal.cuts.filter((c) => c.reason !== "silencio");
      this.wordDel = words.map((w) => fillerRanges.some((c) => w.start < c.end && w.end > c.start));
      this.removeSilence = true;
      this.lastWordClick = -1;
      this.renderTexto();
      return;
    }
    // TRAVA DE SEGURANÇA: mede quanto cada corte apaga de cada clipe. Corte que
    // remove ~um clipe inteiro (take/bloco) vem DESMARCADO por padrão — nada some
    // sozinho; o editor decide se quer mesmo descartar o take.
    const layout = layoutSegments(
      this.proposal.segments.map((s) => ({ flatDurSec: s.audio.clipRef.outSec - s.audio.clipRef.inSec })),
    );
    this.impacts = assessCutsClipImpact(this.proposal.cuts, layout.laid);
    // `review` = o detector achou, mas a decisão é editorial (trecho refeito longo/ambíguo).
    this.enabled = this.proposal.cuts.map((c, i) => !isDangerousCut(this.impacts[i]) && !c.review);
    // Defaults da segmentação: marcador/retake de confiança ALTA já vem marcado; BAIXA
    // (provável conteúdo) vem desmarcado pra revisão. O humano confirma as fronteiras.
    this.markerOn = this.proposal.markers.map((m) => m.confidence === "alta");
    this.signalOn = this.proposal.retakeSignals.map((s) => s.confidence === "alta");
    this.aba = this.proposal.retakeSignals.length ? "retakes" : this.proposal.markers.length ? "blocos" : "finos";
    this.renderRevisar();
  }

  /** Cancela a transcrição/análise em andamento (aborta a requisição no backend). */
  private cancelPropose(): void {
    this.abortController?.abort();
    this.setStatus("Cancelando…");
  }

  private isAbort(err: unknown): boolean {
    return !!err && (err as Error).name === "AbortError";
  }

  // =====================================================================
  // 3. REVISAR
  // =====================================================================

  private renderRevisar(): void {
    this.clear();
    this.tela = "revisar";
    const p = this.proposal;
    if (!p) return this.renderHome();

    if (!p.cuts.length && !p.markers.length && !p.retakeSignals.length) {
      return this.renderNada("Nada para cortar", "Nenhum corte nem marcador falado encontrado nestes clipes.");
    }

    const total = p.cuts.length + p.retakeSignals.length;
    this.dur = durCounter();
    this.tabsEl = make("div", { class: "tabs" });
    this.ctxEl = make("div", { class: "ctx-row" });
    this.listEl = make("div", { class: "rlist" });
    this.footText = make("div");
    this.applyBtn = btn("", "md primary", () => void this.runApply());

    const corpo = make("div", { class: "screen-body stack-32" }, [
      make("div", { class: "head-row" }, [
        make("div", { class: "title-block" }, [
          make("div", { class: "eyebrow", text: "ETAPA 3 DE 3" }),
          make("h1", { class: "h1 md", text: `${total} ${total === 1 ? "corte proposto" : "cortes propostos"}` }),
        ]),
        this.dur.el,
      ]),
      this.tabsEl,
      this.ctxEl,
      this.listEl,
    ]);
    const rodape = footer(this.footText, [btn("Voltar", "md", () => this.renderHome()), this.applyBtn]);
    this.root.appendChild(screen(corpo, rodape));
    this.fillAba();
  }

  /** (Re)monta abas, contexto e lista da aba ativa. */
  private fillAba(): void {
    const p = this.proposal;
    if (!p || !this.tabsEl || !this.ctxEl || !this.listEl) return;

    // --- abas ---
    clearChildren(this.tabsEl);
    this.tabCounts = [];
    const blocks = this.currentBlocks();
    // `extra` é o complemento do rótulo no design ("· silêncio + filler"); some no painel estreito
    const abas: Array<{ id: Aba; label: string; extra?: string; n: string }> = [
      { id: "retakes", label: "Retakes", n: `${this.signalOn.filter(Boolean).length}/${p.retakeSignals.length}` },
      { id: "blocos", label: "Blocos", n: String(blocks.length) },
      { id: "finos", label: "Cortes finos", extra: " · silêncio + filler", n: String(p.cuts.length) },
    ];
    for (const a of abas) {
      const n = make("span", { class: "tab-n", text: a.n });
      this.tabCounts.push(n);
      this.tabsEl.appendChild(
        make(
          "div",
          {
            class: `tab${a.id === this.aba ? " on" : ""}`,
            role: "button",
            onclick: () => {
              this.aba = a.id;
              this.fillAba();
            },
          },
          [a.label, a.extra ? make("span", { class: "tab-extra", text: a.extra }) : null, n],
        ),
      );
    }

    // --- contexto + ações em lote (valem SÓ pra aba visível) ---
    clearChildren(this.ctxEl);
    const textos: Record<Aba, string> = {
      retakes: p.retakeSignals.length
        ? "O chefe avisa quando refaz (“vou ler de novo”). Marcado = descarta o take antes do aviso."
        : "Nenhum retake anunciado na fala.",
      blocos: p.markers.length
        ? "Cada bloco marcado vira uma sequência nova. Confirme as fronteiras."
        : "Nenhum marcador falado — sai uma sequência só, com tudo.",
      finos: "Silêncio, hesitação, falso começo e repetição. Marcado = sai do corte.",
    };
    this.ctxEl.appendChild(make("div", { class: "ctx-text", text: textos[this.aba] }));
    const temItens =
      (this.aba === "retakes" && p.retakeSignals.length) ||
      (this.aba === "blocos" && p.markers.length) ||
      (this.aba === "finos" && p.cuts.length);
    if (temItens) {
      this.ctxEl.appendChild(
        make("div", { class: "bulk" }, [
          btn("Marcar todos", "small", () => this.bulk(true)),
          btn("Desmarcar todos", "small", () => this.bulk(false)),
        ]),
      );
    }

    // --- lista ---
    clearChildren(this.listEl);
    this.fineRowUpdaters = [];
    if (this.aba === "retakes") {
      p.retakeSignals.forEach((s, i) => this.listEl!.appendChild(this.retakeCard(s, i)));
    } else if (this.aba === "blocos") {
      p.markers.forEach((m, i) => this.listEl!.appendChild(this.markerCard(m, i)));
    } else {
      const nPerigo = this.impacts.filter((imp) => isDangerousCut(imp)).length;
      if (nPerigo > 0) {
        this.listEl.appendChild(
          make("div", {
            class: "warn-banner",
            text: `⚠ ${nPerigo} corte(s) apagariam um clipe inteiro — vieram desmarcados por segurança. Marque só se quiser mesmo descartar o take (o "Marcar todos" não mexe neles).`,
          }),
        );
      }
      p.cuts.forEach((c, i) => this.listEl!.appendChild(this.cutCard(c, i)));
    }
    this.updateReview();
  }

  private bulk(on: boolean): void {
    const p = this.proposal;
    if (!p) return;
    if (this.aba === "retakes") this.signalOn = p.retakeSignals.map(() => on);
    else if (this.aba === "blocos") this.markerOn = p.markers.map(() => on);
    else {
      // Corte perigoso (apaga um clipe inteiro) só muda por clique individual — nunca em lote.
      this.enabled = p.cuts.map((_, i) => (isDangerousCut(this.impacts[i]) ? this.enabled[i] : on));
      this.fineRowUpdaters.forEach((f) => f());
      this.updateReview();
      return;
    }
    this.fillAba();
  }

  /** Blocos confirmados (marcadores marcados) → janelas de tempo que viram sequências. */
  private currentBlocks(): Block[] {
    const p = this.proposal;
    if (!p) return [];
    return buildBlocks(p.markers.filter((_, i) => this.markerOn[i]), p.durationSec);
  }

  /** Sinais de retake habilitados (take ruim a descartar). */
  private enabledSignals(): RetakeSignal[] {
    const p = this.proposal;
    if (!p) return [];
    return p.retakeSignals.filter((_, i) => this.signalOn[i]);
  }

  /** Palavras ao redor de um índice de palavra — pro humano reconhecer o marcador. */
  private contextAt(wordIndex: number, before: number, after: number): string {
    const words = this.proposal?.transcript.words ?? [];
    const a = Math.max(0, wordIndex - before);
    const b = Math.min(words.length, wordIndex + after + 1);
    const txt = words.slice(a, b).map((w) => w.word).join(" ").trim();
    return txt.length > 90 ? txt.slice(0, 90).trimEnd() + "…" : txt;
  }

  /** Palavras transcritas que este corte vai remover — pra revisão clara do QUE sai. */
  private cutWords(cut: Cut): string {
    const words = this.proposal?.transcript.words ?? [];
    const dentro = words.filter((w) => w.start < cut.end && w.end > cut.start).map((w) => w.word);
    if (!dentro.length) return "";
    const txt = dentro.join(" ");
    return txt.length > 90 ? txt.slice(0, 90).trimEnd() + "…" : txt;
  }

  private retakeCard(s: RetakeSignal, i: number): HTMLElement {
    const p = this.proposal!;
    const on = this.signalOn[i];
    const block = this.currentBlocks().find((b) => s.startSec >= b.startSec && s.startSec < b.endSec);
    const inicio = block ? block.startSec : 0;
    const head = make("div", { class: "rcard-head" }, [
      check(on),
      make("div", { class: "rcard-title", text: `“${s.phrase}”` }),
      chip(`confiança ${s.confidence}`, !on),
      block ? chip(`bloco: ${block.label}`, !on) : null,
      make("div", { class: "rcard-spacer" }),
      make("div", { class: "rcard-time", text: `${fmtTc(inicio)} → ${fmtTc(s.endSec)}` }),
    ]);
    // Contexto: o fim do take que sai (riscado, se marcado) e o começo do que fica.
    const words = p.transcript.words;
    const antes = words.filter((w) => w.start >= inicio && w.end <= s.endSec + 0.01);
    const depois = words.filter((w) => w.start >= s.endSec - 0.01).slice(0, 12);
    const trecho = antes.slice(-10);
    const ctx = make("div", { class: "rcard-ctx" }, [
      antes.length > trecho.length ? "… " : "",
      make("span", { class: on ? "cut" : "", text: ((t) => (on ? riscar(t) : t))(trecho.map((w) => w.word).join(" ")) }),
      " ",
      make("span", { class: "keep", text: depois.map((w) => w.word).join(" ") + (depois.length === 12 ? " …" : "") }),
    ]);
    const card = make("div", { class: `rcard${on ? " on" : ""}` }, [head, ctx]);
    card.addEventListener("click", () => {
      this.signalOn[i] = !this.signalOn[i];
      this.fillAba(); // contagens e janelas de retake mudam
    });
    return card;
  }

  private markerCard(m: Marker, i: number): HTMLElement {
    const on = this.markerOn[i];
    const ctx = this.contextAt(m.wordIndex, 1, 7);
    const card = make("div", { class: `rcard${on ? " on" : ""}` }, [
      make("div", { class: "rcard-head" }, [
        check(on),
        make("div", { class: "rcard-title", text: m.label }),
        chip(`confiança ${m.confidence}`, !on),
        chip(m.kind === "ad" ? "peça" : "take", !on),
        make("div", { class: "rcard-spacer" }),
        make("div", { class: "rcard-time", text: fmtTc(m.startSec) }),
      ]),
      ctx ? make("div", { class: "rcard-ctx" }, [make("span", { class: "keep", text: `“${ctx}”` })]) : null,
    ]);
    card.addEventListener("click", () => {
      this.markerOn[i] = !this.markerOn[i];
      this.fillAba(); // contagem de blocos e janelas de retake mudam
    });
    return card;
  }

  private cutCard(cut: Cut, i: number): HTMLElement {
    const danger = isDangerousCut(this.impacts[i]);
    const palavras = this.cutWords(cut);
    const titulo = palavras ? `“${palavras}”` : `pausa de ${fmtDec(cut.end - cut.start)} s`;
    const caixa = check(this.enabled[i]);
    const motivo = chip(rotuloMotivo(cut), !this.enabled[i]);
    const card = make("div", {}, [
      make("div", { class: "rcard-head" }, [
        caixa,
        make("div", { class: "rcard-title", text: titulo }),
        motivo,
        make("div", { class: "rcard-spacer" }),
        make("div", { class: "rcard-time", text: `${fmtTc(cut.start)} → ${fmtTc(cut.end)}` }),
      ]),
      danger
        ? make("div", {
            class: "rcard-warn",
            text: `⚠ apaga ${Math.round(this.impacts[i].maxCoverage * 100)}% de um clipe inteiro (${this.impacts[i].removedSec.toFixed(0)} s)`,
          })
        : null,
      cut.detail && cut.reason !== "silencio" ? make("div", { class: "rcard-note", text: cut.detail }) : null,
    ]);
    // A lista de cortes finos NÃO é reconstruída a cada clique (são centenas): atualiza no lugar.
    const pintar = () => {
      const on = this.enabled[i];
      card.className = `rcard${on ? " on" : ""}`;
      setCheck(caixa, on);
      motivo.className = `chip${on ? "" : " dim"}`;
    };
    pintar();
    this.fineRowUpdaters.push(pintar);
    card.addEventListener("click", () => {
      this.enabled[i] = !this.enabled[i];
      pintar();
      this.updateReview();
    });
    return card;
  }

  /** Recalcula ao vivo: contador de duração, contagens das abas, rodapé e botão principal. */
  private updateReview(): void {
    const p = this.proposal;
    if (!p || !this.dur || !this.footText || !this.applyBtn) return;
    const blocks = this.currentBlocks();
    const fine = p.cuts.filter((_, i) => this.enabled[i]);
    const sinais = this.enabledSignals();
    const retakeCuts = blocks.map((b) => retakeCutForBlock(b, sinais)).filter((c): c is Cut => !!c);
    // União dos intervalos: corte fino dentro de um take descartado não conta duas vezes.
    const removido = unionLength([...fine, ...retakeCuts]);
    this.dur.set(p.durationSec, Math.max(0, p.durationSec - removido));

    const nSeq = blocks.length;
    this.footText.textContent =
      `${sinais.length} ${sinais.length === 1 ? "retake aceito" : "retakes aceitos"} · ` +
      `${fine.length} ${fine.length === 1 ? "corte fino" : "cortes finos"} · ` +
      `${nSeq} ${nSeq === 1 ? "bloco" : "blocos"} → ${nSeq} ${nSeq === 1 ? "sequência" : "sequências"}`;
    this.applyBtn.textContent = nSeq ? `Criar ${nSeq} sequência(s)` : "Nada para criar";
    this.applyBtn.disabled = nSeq === 0;

    // Contadores das abas (sem reconstruir a lista).
    if (this.tabCounts.length === 3) {
      this.tabCounts[0].textContent = `${sinais.length}/${p.retakeSignals.length}`;
      this.tabCounts[1].textContent = String(nSeq);
    }
  }

  private async runApply(): Promise<void> {
    const p = this.proposal;
    if (!p) return;
    const blocks = this.currentBlocks();
    const approvedFine: Cut[] = p.cuts.filter((_, i) => this.enabled[i]);
    const enabledSignals = this.enabledSignals();
    this.renderProcessar("apply");
    this.setStatus(`Montando ${blocks.length} sequência(s)…`);
    try {
      const names = await applyBlockSequences(
        this.client,
        p,
        blocks,
        approvedFine,
        enabledSignals,
        this.setStatus,
        RESPIRO[this.respiro],
      );
      const lista = names.length <= 6 ? `: ${names.join(", ")}` : "";
      this.notice = `${names.length} ${names.length === 1 ? "sequência criada" : "sequências criadas"}${lista}.`;
      this.proposal = null;
      this.renderHome();
    } catch (err) {
      this.renderErro(err, "montagem");
    }
  }

  // =====================================================================
  // 5. AUTO-ZOOM
  // =====================================================================

  private renderZoom(): void {
    this.clear();
    this.tela = "zoom";
    const p = this.proposal;
    if (!p) return this.renderHome();
    if (!p.zoomPoints.length) {
      return this.renderNada("Nenhum punch-in proposto", "Nenhuma ponta de interesse encontrada pra zoom nesta transcrição.");
    }

    const n = p.zoomPoints.length;
    const lista = make("div", { class: "zlist" });
    const pintores: Array<() => void> = [];
    p.zoomPoints.forEach((z, i) => {
      const { row, pintar } = this.zoomRow(z, i);
      pintores.push(pintar);
      lista.appendChild(row);
    });
    this.footText = make("div");
    this.applyBtn = btn("", "md primary", () => void this.runApplyZooms());
    const bulk = (on: boolean) => {
      this.zoomOn = p.zoomPoints.map(() => on);
      pintores.forEach((f) => f());
      this.updateZoom();
    };

    const corpo = make("div", { class: "screen-body stack-24 pt-40" }, [
      make("div", { class: "head-row" }, [
        make("div", { class: "title-block tight" }, [
          make("h1", { class: "h1 sm", text: `${n} ${n === 1 ? "punch-in proposto" : "punch-ins propostos"}` }),
          make("div", { class: "sub s15", text: "Escala 100 → 110 → 100 no efeito Transformar, keyframado nos clips da V1." }),
        ]),
        make("div", { class: "bulk" }, [btn("Marcar todos", "small", () => bulk(true)), btn("Desmarcar todos", "small", () => bulk(false))]),
      ]),
      lista,
      make("div", { class: "note", text: "Confiança alta entra marcada. Baixa entra desmarcada, pra você decidir." }),
    ]);
    this.root.appendChild(screen(corpo, footer(this.footText, [btn("Voltar", "md", () => this.renderHome()), this.applyBtn])));
    this.updateZoom();
  }

  private zoomRow(z: ZoomPoint, i: number): { row: HTMLElement; pintar: () => void } {
    const trig = z.trigger === "numero" ? "número" : z.trigger === "pergunta" ? "pergunta" : "ideia";
    const caixa = check(this.zoomOn[i]);
    const chips = [chip(trig), z.confidence === "baixa" ? chip("confiança baixa") : chip(z.style)];
    const row = make("div", {}, [
      caixa,
      make("div", { class: "zword", text: `“${z.word}”` }),
      ...chips,
      make("div", { class: "rcard-spacer" }),
      make("div", { class: "ztime", text: `${fmtTc(z.startSec)} → ${fmtTc(z.endSec)}` }),
    ]);
    const pintar = () => {
      const on = this.zoomOn[i];
      row.className = `zrow${on ? "" : " off"}`;
      setCheck(caixa, on);
      chips.forEach((c) => (c.className = `chip${on ? "" : " dim"}`));
    };
    pintar();
    row.addEventListener("click", () => {
      this.zoomOn[i] = !this.zoomOn[i];
      pintar();
      this.updateZoom();
    });
    return { row, pintar };
  }

  private updateZoom(): void {
    const p = this.proposal;
    if (!p || !this.footText || !this.applyBtn) return;
    const on = this.zoomOn.filter(Boolean).length;
    this.footText.textContent = `${on} de ${p.zoomPoints.length} marcados · aplica nos clips da V1`;
    this.applyBtn.textContent = on ? `Aplicar ${on} zoom(s)` : "Nada selecionado";
    this.applyBtn.disabled = on === 0;
  }

  private async runApplyZooms(): Promise<void> {
    const p = this.proposal;
    if (!p) return;
    const approved = p.zoomPoints.filter((_, i) => this.zoomOn[i]);
    this.renderProcessar("applyZoom");
    this.setStatus("Aplicando o zoom…");
    try {
      const { applied, diag } = await applyZoomPoints(this.client, p, approved, this.setStatus);
      if (applied === 0) {
        // Mostra o diagnóstico NA TELA (o canal /debug pode não chegar durante o apply).
        this.renderDiag(diag, approved.length);
      } else {
        this.notice = `Zoom aplicado em ${applied} clip(s).`;
        this.proposal = null;
        this.renderHome();
      }
    } catch (err) {
      this.renderErro(err, "montagem");
    }
  }

  /** Diagnóstico do Auto-Zoom — o usuário tira um print e dá pra calibrar com os dados reais. */
  private renderDiag(diag: Array<{ label: string; data: unknown }>, approved: number): void {
    this.clear();
    this.tela = "diag";
    const text = diag.length
      ? diag.map((e) => `[${e.label}] ${JSON.stringify(e.data)}`).join("\n\n")
      : "(nenhum evento — o apply nem começou)";
    const corpo = make("div", { class: "screen-body stack-26" }, [
      make("div", { class: "title-block" }, [
        make("div", { class: "eyebrow", text: "AUTO-ZOOM" }),
        make("h1", { class: "h1 sm", text: "Nenhum clipe recebeu zoom" }),
        make("div", { class: "sub", text: `Rodou em ${approved} zoom(s) mas não aplicou em nenhum clipe. Tire um print desta tela:` }),
      ]),
      make("div", { class: "code diag", text }),
    ]);
    this.root.appendChild(screen(corpo, footer("", [btn("Voltar", "md", () => this.renderHome())])));
  }

  // =====================================================================
  // 4. EDITAR POR TEXTO
  // =====================================================================

  private renderTexto(): void {
    this.clear();
    this.tela = "texto";
    const p = this.proposal;
    if (!p) return this.renderHome();
    const words = p.transcript.words;
    if (!words.length) return this.renderNada("Sem transcrição", "Não há transcrição pra editar nestes clipes.");

    this.dur = durCounter(true);
    this.footText = make("div");
    this.applyBtn = btn("Montar o corte na timeline", "md primary", () => void this.runApplyTextEdit());

    const caixa = check(this.removeSilence, true);
    const toggle = make("div", { class: "te-toggle" }, [caixa, make("span", { text: "Remover silêncios e respiros junto" })]);
    toggle.addEventListener("click", () => {
      this.removeSilence = !this.removeSilence;
      setCheck(caixa, this.removeSilence);
      this.updateTexto();
    });
    const barra = make("div", { class: "te-bar" }, [
      toggle,
      make("div", { class: "te-legend" }, [
        make("span", { text: "riscado = cortado" }),
        make("span", { class: "sep", text: "|" }),
        make("span", { text: "clique para alternar" }),
        make("span", { class: "sep", text: "|" }),
        make("span", { text: "shift+clique = trecho" }),
      ]),
    ]);
    this.syncNoteEl = make("div", { class: "te-sync", text: "lendo a timeline…" });

    const tx = make("div", { class: "tx" });
    this.wordSpans = [];
    words.forEach((w, i) => {
      const span = make("span", { class: "tw" + (this.wordDel[i] ? " del" : ""), text: this.textoPalavra(i) });
      span.addEventListener("click", (e: Event) => this.onWordClick(i, e as MouseEvent));
      this.wordSpans.push(span);
      tx.appendChild(span);
      tx.appendChild(document.createTextNode(" ")); // o espaço deixa a linha quebrar entre palavras
    });

    const corpo = make("div", { class: "screen-body stack-26 pt-40" }, [
      make("div", { class: "head-row" }, [
        make("div", { class: "title-block tight" }, [
          make("h1", { class: "h1 sm", text: "Editar por texto" }),
          make("div", { class: "sub s15", text: "Clique numa palavra para cortá-la. O corte acontece na sequência nova." }),
        ]),
        this.dur.el,
      ]),
      barra,
      this.syncNoteEl,
      tx,
    ]);
    this.root.appendChild(screen(corpo, footer(this.footText, [btn("Voltar", "md", () => this.renderHome()), this.applyBtn])));
    this.updateTexto();
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
      if (this.mode === "text" && this.tela === "texto") this.scheduleTextSync();
    })();
  }

  private scheduleTextSync(): void {
    // setTimeout recursivo (não setInterval): a próxima leitura só agenda depois desta terminar,
    // então nunca há duas leituras da timeline sobrepostas.
    this.textSyncTimer = setTimeout(async () => {
      if (this.tela !== "texto" || !this.proposal) return this.stopTextSync();
      await this.syncTextFromTimeline(false);
      if (this.tela === "texto") this.scheduleTextSync();
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
    const laid = layoutSegments(segs.map((s) => ({ flatDurSec: s.audio.clipRef.outSec - s.audio.clipRef.inSec }))).laid;
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
    if (this.tela !== "texto" || !this.proposal) return;
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
    this.updateTexto();
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
    this.updateTexto();
  }

  private setWordDel(i: number, del: boolean): void {
    this.wordDel[i] = del;
    const span = this.wordSpans[i];
    if (span) {
      span.className = "tw" + (del ? " del" : "");
      span.textContent = this.textoPalavra(i);
    }
  }

  /** Palavra como aparece no editor: riscada (caractere U+0336) quando vai ser cortada. */
  private textoPalavra(i: number): string {
    const w = this.proposal?.transcript.words[i]?.word.trim() ?? "";
    return this.wordDel[i] ? riscar(w) : w;
  }

  /** Resumo vivo: palavras cortadas + respiros + contador de duração + botão. */
  private updateTexto(): void {
    const p = this.proposal;
    if (!p || !this.dur || !this.footText || !this.applyBtn) return;
    const words = p.transcript.words;
    const cortes: Array<{ start: number; end: number }> = [];
    let nPalavras = 0;
    words.forEach((w, i) => {
      if (this.wordDel[i]) {
        cortes.push(w);
        nPalavras++;
      }
    });
    const silencios = this.removeSilence ? p.cuts.filter((c) => c.reason === "silencio") : [];
    const removido = unionLength([...cortes, ...silencios]);
    this.dur.set(p.durationSec, Math.max(0, p.durationSec - removido));
    this.footText.textContent =
      `${nPalavras} ${nPalavras === 1 ? "palavra cortada" : "palavras cortadas"} · ` +
      `${silencios.length} ${silencios.length === 1 ? "respiro" : "respiros"}`;
    this.applyBtn.disabled = nPalavras === 0 && silencios.length === 0;
  }

  private async runApplyTextEdit(): Promise<void> {
    const p = this.proposal;
    if (!p) return;
    const words = p.transcript.words;
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
    const silenceCuts = this.removeSilence ? p.cuts.filter((c) => c.reason === "silencio") : [];
    const allCuts = [...silenceCuts, ...wordCuts];
    if (!allCuts.length) return;

    this.renderProcessar("applyText");
    this.setStatus("Montando o corte na timeline…");
    try {
      const seqName = await applyApprovedCuts(this.client, p, allCuts, this.setStatus, RESPIRO[this.respiro]);
      this.notice = `Sequência “${seqName}” criada — ${wordCuts.length} trecho(s) removido(s) por texto.`;
      this.proposal = null;
      this.renderHome();
    } catch (err) {
      this.renderErro(err, "montagem");
    }
  }

  // =====================================================================
  // 6. EXPORTAR SRT
  // =====================================================================

  private renderSrt(): void {
    this.clear();
    this.tela = "srt";
    const cartoes: Record<CaptionStyle, HTMLElement> = {} as Record<CaptionStyle, HTMLElement>;
    const radios: Record<CaptionStyle, HTMLElement> = {} as Record<CaptionStyle, HTMLElement>;
    const pintar = () => {
      (Object.keys(cartoes) as CaptionStyle[]).forEach((k) => {
        const on = k === this.captionStyle;
        cartoes[k].className = `srt-card${on ? " on" : ""}`;
        radios[k].className = `radio${on ? " on" : ""}`;
        radios[k].textContent = on ? "✓" : "";
      });
    };
    const cartao = (estilo: CaptionStyle, desc: string, amostra: HTMLElement): HTMLElement => {
      radios[estilo] = make("div", { class: "radio" });
      cartoes[estilo] = make(
        "div",
        {
          onclick: () => {
            this.captionStyle = estilo;
            pintar();
          },
        },
        [
          make("div", { class: "srt-card-head" }, [make("div", { class: "srt-card-name", text: ESTILO_LEGENDA[estilo] }), radios[estilo]]),
          make("div", { class: "srt-card-desc", text: desc }),
          amostra,
        ],
      );
      return cartoes[estilo];
    };

    const corpo = make("div", { class: "screen-body stack-26 pt-40" }, [
      make("div", { class: "title-block tight" }, [
        make("h1", { class: "h1 sm", text: "Exportar SRT" }),
        make("div", { class: "sub s15", text: "As mesmas palavras, montadas em dois formatos diferentes." }),
      ]),
      make("div", { class: "srt-cards" }, [
        cartao(
          "reels",
          "1 linha de até 14 caracteres, mínimo 1,6 s, sem gap. Na prática, palavra por palavra. Dinheiro por extenso.",
          make("div", { class: "srt-sample reels", text: "quarenta mil" }),
        ),
        cartao(
          "cinema",
          "Até 2 linhas de 42 caracteres, 5–7 s, 2 frames de gap, teto de 17 caracteres por segundo. Dinheiro em numeral.",
          make("div", { class: "srt-sample cinema" }, [
            make("div", {}, [make("div", { text: "e no primeiro mês a gente fechou" }), make("div", { text: "R$ 40.000 em vendas" })]),
          ]),
        ),
      ]),
      make("div", { class: "opt-list" }, [
        optRow("Sincronia da legenda", numStepper(this.srtSyncSec, 0.1, (v) => (this.srtSyncSec = v)), "+ atrasa · − adianta"),
      ]),
      make("div", {
        class: "note",
        text: "Texto em minúsculas e sem pontuação nos dois estilos. As correções de nomes próprios rodam sempre.",
      }),
    ]);
    pintar();
    this.root.appendChild(
      screen(
        corpo,
        footer("Roda na seleção, ou na sequência inteira se nada estiver selecionado", [
          btn("Voltar", "md", () => this.renderHome()),
          btn("Exportar .srt", "md primary", () => void this.runExportSrt()),
        ]),
      ),
    );
  }

  private async runExportSrt(): Promise<void> {
    this.abortController?.abort(); // mata request anterior ainda vivo (evita transcrição duplicada)
    this.abortController = new AbortController();
    this.notice = null;
    this.renderProcessar("srt", () => this.cancelPropose());
    try {
      this.client.setConfig(this.cfg);
      const { srt, count } = await exportSrt(
        this.client,
        this.setStatus,
        this.abortController.signal,
        this.srtSyncSec,
        this.captionStyle,
      );
      this.setStatus("Salvando o .srt…");
      const nome = await saveSrtFile(srt, `legendas-${this.captionStyle}.srt`);
      if (nome) {
        this.notice = `${count} legenda(s) no estilo ${ESTILO_LEGENDA[this.captionStyle]} salvas em “${nome}”.`;
        this.renderHome();
      } else {
        this.renderSrt(); // usuário fechou o seletor de arquivo
      }
    } catch (err) {
      if (this.isAbort(err)) this.renderSrt();
      else this.renderErro(err, "antes");
    } finally {
      this.abortController = null;
    }
  }

  // =====================================================================
  // 7. CONFIG
  // =====================================================================

  private renderConfig(): void {
    this.clear();
    this.tela = "config";
    const statusBox = make("div", { class: "cfg-status" });
    const pintarStatus = () => {
      clearChildren(statusBox);
      const titulo =
        this.backendOk === null ? "Verificando…" : this.backendOk ? "Backend no ar" : "Backend fora do ar";
      statusBox.appendChild(
        make("div", { class: "cfg-status-left" }, [
          make("div", { class: `dot lg${this.backendOk ? " ok" : this.backendOk === false ? " off" : ""}` }),
          make("div", { class: "cfg-status-title", text: titulo }),
          make("div", { class: "cfg-url", text: this.cfg.baseUrl }),
        ]),
      );
      statusBox.appendChild(
        btn("Testar conexão", "small", () => {
          this.backendOk = null;
          pintarStatus();
          this.refreshHealth(() => {
            pintarStatus();
            pintarValores();
          });
        }),
      );
    };

    const urlInput = make("input", {
      class: "cfg-input",
      type: "text",
      value: this.cfg.baseUrl,
      oninput: (e: Event) => (this.cfg.baseUrl = (e.target as HTMLInputElement).value.trim()),
    });
    const tokenInput = make("input", {
      class: "cfg-input",
      type: "text",
      placeholder: "vazio (uso local)",
      value: this.cfg.authToken ?? "",
      oninput: (e: Event) => (this.cfg.authToken = (e.target as HTMLInputElement).value),
    });
    const motor = make("div", { class: "cfg-value" });
    const analise = make("div", { class: "cfg-value" });
    const silencio = make("div", { class: "cfg-value" });
    const pintarValores = () => {
      const h = this.health;
      motor.textContent = h ? this.motorLabel() : "—";
      analise.textContent = this.analiseLabel();
      const thr = h?.silenceThresholdDb;
      silencio.textContent =
        thr == null
          ? "—"
          : `${thr < 0 ? "−" : ""}${Math.abs(thr)} dB · ${fmtDec(RESPIRO[this.respiro].minSilenceSec, 2)} s`;
    };

    const corpo = make("div", { class: "screen-body stack-26 pt-40" }, [
      make("div", { class: "title-block tight" }, [
        make("h1", { class: "h1 sm", text: "Config" }),
        make("div", { class: "sub s15" }, [
          "O painel só fala HTTP com o backend local. As chaves ficam no ",
          make("span", { class: "mono", text: "server/.env" }),
          ".",
        ]),
      ]),
      statusBox,
      make("div", { class: "opt-list" }, [
        optRow("Endereço do backend", urlInput),
        optRow("Token de autorização", tokenInput),
        optRow("Motor de transcrição", motor, "definido em TRANSCRIBER"),
        optRow("Análise dos cortes", analise, "definido em ANALYZER"),
        optRow("Detector de silêncio", silencio, `limiar do backend · pausa mínima do Respiro ${RESPIRO[this.respiro].label}`),
      ]),
      make("div", {
        class: "note",
        text: "Motor, análise e limiar são variáveis de ambiente do backend. Pra trocar, edite o server/.env e reinicie o backend.",
      }),
    ]);
    this.root.appendChild(screen(corpo, footer("", [btn("Voltar", "md", () => this.renderHome())])));
    pintarStatus();
    pintarValores();
    this.refreshHealth(() => {
      pintarStatus();
      pintarValores();
    });
  }

  // =====================================================================
  // 8. ERRO  ·  tela de "nada aqui"
  // =====================================================================

  private renderErro(err: unknown, fase: FaseErro): void {
    this.clear();
    this.tela = "erro";
    const msg = err instanceof Error ? err.message : String(err);
    const foraDoAr = msg.startsWith("Não consegui falar com o backend");
    const host = this.cfg.baseUrl.replace(/^https?:\/\//, "");
    const quando = new Date();
    const hora = [quando.getHours(), quando.getMinutes(), quando.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    const chamada = this.client.lastCall ? `em POST ${this.client.lastCall.path} · ` : "";
    const detalhe = `${msg}\n${chamada}${hora}`;

    const titulo = foraDoAr ? `Não consegui falar com o backend em ${host}` : msg.split("\n")[0].slice(0, 140);
    const sub =
      fase === "montagem"
        ? "A sequência original não foi tocada. Se uma sequência nova ficou pela metade, apague-a no painel Projeto."
        : `Nada foi alterado na sua timeline.${foraDoAr ? " Suba o servidor e tente de novo." : ""}`;

    const copiar = btn("Copiar detalhe técnico", "md", () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(detalhe);
          copiar.textContent = "Copiado";
        } catch {
          copiar.textContent = "Não consegui copiar — o detalhe está aqui embaixo";
        }
      })();
    });
    const tentar = btn("Tentar de novo", "md primary", () => {
      if (foraDoAr) {
        this.refreshHealth(() => (this.backendOk ? this.voltarDepoisDoErro() : undefined));
      } else {
        this.voltarDepoisDoErro();
      }
    });

    const corpo = make("div", { class: "screen-body stack-26 pt-56" }, [
      make("div", { class: "err-label" }, [
        make("div", { class: "dot xl danger" }),
        make("span", { text: foraDoAr ? "BACKEND FORA DO AR" : "ALGO DEU ERRADO" }),
      ]),
      make("div", { class: "title-block" }, [
        make("h1", { class: "h1 sm err-title", text: titulo }),
        make("div", { class: "sub", style: "max-width: 620px", text: sub }),
      ]),
      foraDoAr
        ? make("div", {
            class: "code",
            text:
              "# reinicia o backend (ele roda como serviço do macOS)\n" +
              "launchctl kickstart -k gui/$(id -u)/com.reconecta.autocut-backend\n" +
              "# se não subir, o motivo está no log\n" +
              "tail -n 40 /tmp/autocut-backend.log",
          })
        : null,
      make("div", { class: "btn-row" }, [tentar, copiar]),
      make("div", { class: "err-detail", text: detalhe }),
    ]);
    this.root.appendChild(screen(corpo));
  }

  /** "Tentar de novo": volta pra revisão/zoom/texto se ainda há proposta; senão, pro início. */
  private voltarDepoisDoErro(): void {
    if (!this.proposal) return this.renderHome();
    if (this.mode === "zoom") this.renderZoom();
    else if (this.mode === "text") this.renderTexto();
    else this.renderRevisar();
  }

  private renderNada(titulo: string, texto: string): void {
    this.clear();
    this.tela = "nada";
    const corpo = make("div", { class: "screen-body stack-26 pt-72" }, [
      make("div", { class: "empty-mark" }),
      make("div", { class: "title-block" }, [
        make("h1", { class: "h1 sm", text: titulo }),
        make("div", { class: "sub", style: "max-width: 560px", text: texto }),
      ]),
      make("div", {}, [btn("Voltar", "md", () => this.renderHome())]),
    ]);
    this.root.appendChild(screen(corpo));
  }
}
