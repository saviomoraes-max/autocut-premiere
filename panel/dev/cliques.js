// Confere, DENTRO do UXP, que os controles (que são <div>, não <button>) respondem ao clique.
// Uso: node panel/dev/uxp.mjs evalfile panel/dev/cliques.js   (abre e mexe na home e na revisão
// com o bruto de teste — rode `node panel/dev/uxp.mjs tela revisar` antes para aquecer o cache)
new Promise((resolve) => {
  const c = globalThis.__autocutDev;
  const res = [];
  const ok = (nome, cond) => res.push(`${cond ? "ok  " : "FALHOU"} ${nome}`);
  const clicar = (el) => el.dispatchEvent(new Event("click"));
  // querySelector/querySelectorAll com seletor de descendente falham às vezes no UXP 9.3 (o CSS
  // aplica certo, a busca não) — medido. Aqui só busca por UMA classe.
  const qa = (cls) => Array.from(document.getElementsByClassName(cls));
  const q = (cls) => qa(cls)[0] || null;
  const dentro = (cls, filho) => Array.from((q(cls) || { children: [] }).children).filter((e) => !filho || e.className.indexOf(filho) >= 0);
  // erro dentro do setTimeout não chega na Promise — captura e devolve junto do que já passou
  const depois = (ms, f) =>
    setTimeout(() => {
      try {
        f();
      } catch (e) {
        res.push(`ERRO ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e}`);
        resolve(res.join("\n"));
      }
    }, ms);

  c.notice = null;
  c.renderHome();
  depois(300, () => {
    // segmentado
    const seco = qa("seg-opt").find((e) => e.textContent === "Seco");
    clicar(seco);
    ok("Respiro: clicar em Seco seleciona Seco", /\bon\b/.test(seco.className) && c.respiro === "seco");
    clicar(qa("seg-opt").find((e) => e.textContent === "Natural"));
    ok("Respiro: volta pra Natural", c.respiro === "natural");
    const cinema = qa("seg-opt").find((e) => e.textContent === "Cinema");
    clicar(cinema);
    ok("Estilo: Cinema", c.captionStyle === "cinema");
    clicar(qa("seg-opt").find((e) => e.textContent === "Reels"));
    // stepper numérico
    const [menos, mais] = qa("ns-btn");
    clicar(mais); clicar(mais);
    ok("Sincronia: + + → 0,2 s", Math.abs(c.srtSyncSec - 0.2) < 1e-9);
    clicar(menos); clicar(menos);
    ok("Sincronia: − − → 0", Math.abs(c.srtSyncSec) < 1e-9);
    // chip de atalho
    const antes = c.userPrompt;
    clicar(qa("pchip")[1]);
    ok("Atalho 'Sem filler' entra no prompt", /sem filler/i.test(c.userPrompt));
    c.userPrompt = antes;
    // Config
    clicar(dentro("status-row", "linkbtn")[0]);
    depois(300, () => {
      ok("Link Config abre a tela Config", c.tela === "config");
      clicar(qa("btn").find((e) => e.textContent === "Voltar"));
      depois(300, () => {
        ok("Voltar da Config → home", c.tela === "home");
        // revisão com proposta já carregada
        if (!c.proposal) { res.push("(sem proposta — rode `tela revisar` antes)"); return resolve(res.join("\n")); }
        c.receberProposta("cut");
        depois(400, () => {
          const abas = qa("tab");
          clicar(abas[2]);
          depois(300, () => {
            ok("Aba Cortes finos", c.aba === "finos");
            const cartao = q("rcard");
            const estava = c.enabled[0];
            clicar(cartao);
            ok("Clicar no cartão alterna o corte", c.enabled[0] === !estava);
            clicar(cartao);
            clicar(dentro("bulk")[1]);
            ok("Desmarcar todos (aba visível)", c.enabled.every((e) => !e));
            clicar(dentro("bulk")[0]);
            ok("Marcar todos", c.enabled.filter(Boolean).length > 0);
            // zoom: desmarcar tudo desabilita o botão principal e o clique não faz nada
            c.receberProposta("zoom");
            depois(400, () => {
              clicar(dentro("bulk")[1]);
              const principal = dentro("foot-actions", "primary")[0];
              ok("Sem zoom marcado → botão principal desabilitado", principal.disabled === true && /disabled/.test(principal.className));
              const tela = c.tela;
              clicar(principal);
              depois(200, () => {
                ok("Clique no botão desabilitado não faz nada", c.tela === tela);
                c.proposal = null;
                c.renderHome();
                resolve(res.join("\n"));
              });
            });
          });
        });
      });
    });
  });
})
