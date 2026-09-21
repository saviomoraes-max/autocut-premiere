// Peças visuais do painel (redesign "1a Quieto", 21/09/2026). DOM imperativo, sem innerHTML —
// o UXP não é um navegador completo. As classes vivem em styles.css; aqui só se monta.
//
// Nada de glifo desenhado: os "ícones" são caracteres de texto (✓ − +), como pede o handoff.
//
// NENHUM <button> aqui: no UXP ele é widget nativo — ignora a cor de fundo, impõe largura e
// altura mínimas e 6 px de margem, e com raio grande vira elipse (medido no Premiere 26.5:
// o "−" do stepper saía com 78×36 px). Tudo que é clicável é <div> com as classes do design.

// Mini-helper "hyperscript" para montar DOM sem innerHTML.
export type Attrs = Record<string, unknown>;
export function make(tag: string, attrs: Attrs = {}, children: (Node | string | null)[] = []): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") e.className = String(v);
    else if (k === "role") e.setAttribute("role", String(v)); // <div> clicável se anuncia como botão
    else if (k === "text") e.textContent = String(v);
    else if (k === "style") e.setAttribute("style", String(v)); // UXP não aceita e.style = "string"
    else if (k.startsWith("on") && typeof v === "function") {
      e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      (e as unknown as Record<string, unknown>)[k] = v;
    }
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

/** Risca o texto com o caractere combinante U+0336 depois de cada letra. O UXP CALCULA
 *  `text-decoration: line-through` mas não desenha (foto do Premiere 26.5, 21/09) — e "riscado =
 *  cortado" é a linguagem da revisão e do editor por texto. */
export function riscar(texto: string): string {
  return Array.from(texto)
    .map((c) => c + "\u0336")
    .join("");
}

export function clearChildren(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------- formatos ----------

/** 1122 s → "18:42"; 3700 s → "1:01:40". Relógio de duração, sem décimos. */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}

/** 461.2 s → "07:41.2" (timecode com décimo, como nos cartões do design). */
export function fmtTc(sec: number): string {
  const t = Math.max(0, sec);
  const m = Math.floor(t / 60);
  const r = t - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
}

/** Número com vírgula decimal: 0.1 → "0,1". */
export function fmtDec(v: number, casas = 1): string {
  return v.toFixed(casas).replace(".", ",");
}

/** Soma o tempo coberto por um conjunto de intervalos, sem contar duas vezes o que se sobrepõe. */
export function unionLength(intervals: Array<{ start: number; end: number }>): number {
  const ord = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const i of ord) {
    if (i.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else if (i.end > curEnd) {
      curEnd = i.end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

// ---------- peças ----------

/** Botão do design. `disabled` imita o do <button>: esmaece (classe) e ignora o clique. */
export type Botao = HTMLElement & { disabled: boolean };
export function btn(text: string, cls: string, onClick: () => void): Botao {
  const el = make("div", { class: `btn ${cls}`, text, role: "button" }) as Botao;
  let desligado = false;
  Object.defineProperty(el, "disabled", {
    get: () => desligado,
    set: (v: boolean) => {
      desligado = !!v;
      el.className = el.className.replace(/\s*\bdisabled\b/g, "") + (desligado ? " disabled" : "");
    },
  });
  el.addEventListener("click", () => {
    if (!desligado) onClick();
  });
  return el;
}

/** Texto clicável sem cara de botão (link "Config", "Fechar"). */
export function link(text: string, onClick: () => void): HTMLElement {
  return make("div", { class: "linkbtn", text, role: "button", onclick: onClick });
}

/** Caixa de marcação 22×22 (marcada = fundo claro com ✓). Só visual: quem alterna é a linha. */
export function check(on: boolean, small = false): HTMLElement {
  const el = make("div", { class: `check${small ? " sm" : ""}` });
  setCheck(el, on);
  return el;
}
export function setCheck(el: HTMLElement, on: boolean): void {
  el.className = el.className.replace(/\s*\bon\b/g, "") + (on ? " on" : "");
  el.textContent = on ? "✓" : "";
}

export function chip(text: string, dim = false): HTMLElement {
  return make("span", { class: `chip${dim ? " dim" : ""}`, text });
}

/** Stepper do cabeçalho: Configurar · Processar · Revisar (a etapa atual preenchida). */
export function stepper(active: 1 | 2 | 3): HTMLElement {
  const nomes = ["Configurar", "Processar", "Revisar"];
  const filhos: HTMLElement[] = [];
  nomes.forEach((nome, i) => {
    if (i > 0) filhos.push(make("div", { class: "step-line" }));
    filhos.push(
      make("div", { class: `step${i + 1 === active ? " on" : ""}` }, [
        make("div", { class: "step-num", text: String(i + 1) }),
        make("span", { class: "step-label", text: nome }),
      ]),
    );
  });
  return make("div", { class: "steps" }, filhos);
}

/** Contador 18:42 → 13:08 −5:34. `set` recalcula ao vivo a cada marcação.
 *  (alinhados pela base da caixa, não por `baseline` — a Adobe documenta baseline como bugado) */
export function durCounter(compact = false): { el: HTMLElement; set: (totalSec: number, finalSec: number) => void } {
  const old = make("span", { class: "dur-old" });
  const arrow = make("span", { class: "dur-arrow", text: "→" });
  const novo = make("span", { class: "dur-new" });
  const diff = make("span", { class: "dur-diff" });
  const el = make("div", { class: `dur${compact ? " compact" : ""}` }, compact ? [old, novo, diff] : [old, arrow, novo, diff]);
  return {
    el,
    set: (totalSec, finalSec) => {
      old.textContent = riscar(fmtClock(totalSec));
      novo.textContent = fmtClock(finalSec);
      diff.textContent = `−${fmtClock(Math.max(0, totalSec - finalSec))}`;
    },
  };
}

/** Grupo segmentado de pílulas (Seco · Natural · Suave). Atualiza no lugar, sem re-render. */
export function segmented<T extends string>(
  opcoes: Array<{ value: T; label: string }>,
  atual: T,
  onChange: (v: T) => void,
): HTMLElement {
  const el = make("div", { class: "seg" });
  const botoes: HTMLElement[] = [];
  for (const o of opcoes) {
    const b = make("div", {
      class: `seg-opt${o.value === atual ? " on" : ""}`,
      role: "button",
      text: o.label,
      onclick: () => {
        botoes.forEach((x) => (x.className = "seg-opt"));
        b.className = "seg-opt on";
        onChange(o.value);
      },
    });
    botoes.push(b);
    el.appendChild(b);
  }
  return el;
}

/** Stepper numérico mono: − 0,0 s + (passo fixo). */
export function numStepper(valor: number, passo: number, onChange: (v: number) => void): HTMLElement {
  let v = valor;
  const txt = make("span", { text: `${fmtDec(v)} s` });
  const mudar = (d: number) => {
    v = Math.round((v + d) * 10) / 10;
    txt.textContent = `${fmtDec(v)} s`;
    onChange(v);
  };
  return make("div", { class: "num-stepper" }, [
    make("div", { class: "ns-btn", text: "−", role: "button", onclick: () => mudar(-passo) }),
    txt,
    make("div", { class: "ns-btn", text: "+", role: "button", onclick: () => mudar(passo) }),
  ]);
}

/** Linha de opção: rótulo (e sub-rótulo) à esquerda, controle à direita. No painel estreito o
 *  CSS empilha: rótulo em cima, controle embaixo na largura toda. */
export function optRow(label: string, controle: HTMLElement, sub?: string): HTMLElement {
  const esquerda = make("div", { class: "opt-left" }, [
    make("div", { class: "opt-label", text: label }),
    sub ? make("div", { class: "opt-sub", text: sub }) : null,
  ]);
  const ctl = make("div", { class: "opt-ctl" }, [controle]);
  return make("div", { class: "opt-row" }, [esquerda, ctl]);
}

/** Casco de tela: corpo rolável + rodapé fixo opcional. */
export function screen(corpo: HTMLElement, rodape?: HTMLElement | null): HTMLElement {
  return make("div", { class: "screen" }, [corpo, rodape ?? null]);
}

/** Rodapé fixo: resumo à esquerda (pode encolher), botões à direita (nunca quebram texto). */
export function footer(texto: HTMLElement | string, acoes: HTMLElement[]): HTMLElement {
  const t = typeof texto === "string" ? make("div", { class: "foot-text", text: texto }) : texto;
  if (typeof texto !== "string") t.className = "foot-text";
  return make("div", { class: "screen-foot" }, [t, make("div", { class: "foot-actions" }, acoes)]);
}

// ---------- animações ----------
// O UXP não documenta @keyframes nem transform, então as duas animações do design rodam aqui,
// mexendo só em `margin-left` e `opacity` (propriedades da lista suportada):
//   barra indeterminada: 30% da largura, vai de −30% a 96% em 1,8 s, ease-in-out;
//   bolinha da etapa ativa: opacidade 0,35 ↔ 1 em 1,4 s.

export function animarProcesso(barra: HTMLElement | null, bolinhas: HTMLElement[]): () => void {
  const t0 = Date.now();
  const tick = () => {
    const agora = Date.now() - t0;
    if (barra) {
      const t = (agora % 1800) / 1800;
      const e = 0.5 - Math.cos(Math.PI * t) / 2; // ease-in-out
      barra.setAttribute("style", `margin-left:${(-30 + 126 * e).toFixed(2)}%`);
    }
    const p = (agora % 1400) / 1400;
    const op = 0.35 + 0.65 * (0.5 - Math.cos(2 * Math.PI * p) / 2);
    for (const b of bolinhas) b.setAttribute("style", `opacity:${op.toFixed(3)}`);
  };
  tick();
  const id = setInterval(tick, 33);
  return () => clearInterval(id);
}
