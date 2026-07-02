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
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    const pre = document.createElement("pre");
    pre.textContent = "Erro ao iniciar o AutoCut:\n\n" + msg;
    pre.style.color = "#e25555";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.padding = "12px";
    pre.style.fontSize = "11px";
    root.appendChild(pre);
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
