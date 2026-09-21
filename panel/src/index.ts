// Entrypoint do painel UXP.
import { entrypoints } from "uxp";
import { mountApp } from "./ui/app";
import styleText from "./styles.css";

// Injeta o CSS EMBUTIDO no bundle como <style>. Vem DEPOIS do <link> do index.html no
// <head>, então sobrescreve qualquer styles.css que o UXP tenha cacheado. Idempotente.
function injectStyles(): void {
  try {
    const existing = document.getElementById("autocut-styles");
    if (existing) existing.textContent = styleText;
    else {
      const style = document.createElement("style");
      style.id = "autocut-styles";
      style.textContent = styleText;
      document.head.appendChild(style);
    }
  } catch {
    /* injeção de estilo não pode derrubar o boot */
  }
}

function start(): void {
  injectStyles();
  const root = document.getElementById("root") ?? document.body;
  try {
    mountApp(root);
  } catch (err) {
    // No UXP o console fica escondido — então, se algo quebrar na montagem,
    // mostramos o erro no próprio painel pra não ficar em branco.
    // Estilo INLINE de propósito: se foi o CSS que quebrou, a mensagem ainda aparece legível.
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    const box = document.createElement("div");
    box.setAttribute("style", "padding: 24px; background-color: #0b0b0c; min-height: 100%;");
    const rotulo = document.createElement("div");
    rotulo.textContent = "ERRO AO INICIAR O AUTOCUT";
    rotulo.setAttribute("style", "font-family: ui-monospace, Menlo, monospace; font-size: 13px; letter-spacing: 0.1em; color: #e25555;");
    const detalhe = document.createElement("div");
    detalhe.textContent = msg;
    detalhe.setAttribute(
      "style",
      "margin-top: 16px; font-family: ui-monospace, Menlo, monospace; font-size: 13px; line-height: 1.7; color: #9a9aa3; white-space: pre-wrap;",
    );
    box.appendChild(rotulo);
    box.appendChild(detalhe);
    root.appendChild(box);
  }
}

// 1) Monta já: o <script> roda no fim do <body>, então #root já existe.
start();
// 2) E também no DOMContentLoaded e no lifecycle do painel (idempotente — guard em mountApp).
document.addEventListener("DOMContentLoaded", start);
try {
  entrypoints.setup({
    panels: {
      "autocut.panel": {
        show: () => start(),
        create: () => start(),
      },
    },
  });
} catch {
  // Alguns ambientes montam direto sem entrypoints.setup.
}
