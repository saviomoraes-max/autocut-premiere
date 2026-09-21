// Mede a tela aberta DENTRO do UXP e acusa os defeitos de layout que o olho pegaria:
//   SOBREPÕE  irmãos que se cobrem (o sintoma da primeira versão do redesign)
//   ESTOURA   elemento que passa da borda do conteúdo (texto cortado / rolagem de lado)
//   VAZA      conteúdo maior que a própria caixa
// Uso: node panel/dev/uxp.mjs medir [largura] [arvore]
// A largura é SIMULADA: as @media do CSS injetado são reescritas pra aquela largura e a tela
// ganha essa largura fixa (o painel real não muda de tamanho). Sem largura = a do painel.
(largura, arvore) =>
  new Promise((resolve) => {
    const estilo = document.getElementById("autocut-styles");
    const original = estilo ? estilo.textContent : "";
    const tela = document.querySelector(".screen");
    // o index.html também carrega o styles.css por <link>: na simulação ele sai (senão as @media
    // dele continuam valendo pra largura real do painel) e volta no fim
    const link = document.querySelector('link[rel="stylesheet"]');
    const linkPai = link ? link.parentNode : null;
    if (largura && link) linkPai.removeChild(link);
    if (largura && estilo) {
      estilo.textContent = original.replace(/@media\s*\(max-width:\s*(\d+)px\)/g, (_m, n) =>
        largura <= Number(n) ? "@media (max-width: 100000px)" : "@media (max-width: 1px)",
      );
      if (tela) tela.setAttribute("style", `right: auto; width: ${largura}px;`);
    }
    // espera o layout assentar: a largura simulada pegar e a altura parar de mudar (a tela de
    // texto tem ~1.100 palavras e o UXP leva bem mais que um quadro pra refazer tudo)
    const t0 = Date.now();
    let ultima = -1;
    const esperar = (feito) => {
      const b = document.querySelector(".screen-body");
      const w = b ? Math.round(b.getBoundingClientRect().width) : 0;
      const h = b ? b.scrollHeight : 0;
      const pronto = b && (!largura || w === largura) && h === ultima;
      ultima = h;
      if (pronto || Date.now() - t0 > 8000) feito();
      else setTimeout(() => esperar(feito), 150);
    };
    setTimeout(() => esperar(() => {
      const linhas = [];
      const problemas = [];
      const corpo = document.querySelector(".screen-body");
      const rc = (corpo || document.body).getBoundingClientRect();
      const W = Math.round(rc.width);
      const nome = (el) => `${el.tagName.toLowerCase()}.${String(el.className || "").trim().replace(/\s+/g, ".")}`;
      const texto = (el) => (el.children.length === 0 && el.textContent ? ` "${el.textContent.trim().slice(0, 26)}"` : "");
      const semRolagem = (el) => !/screen-body|diag|code/.test(String(el.className));
      // linhas que quebram usam margem negativa no pai (o UXP não tem `gap`): a caixa delas inclui
      // a margem dos filhos e passa do pai de propósito — não é defeito
      const quebra = /field-input|prompt-chips|actions-row|rcard-head|btn-row|foot-actions|source-meta|bulk|track-fill/;
      const andar = (el, nivel) => {
        const filhos = Array.from(el.children).filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        });
        const cs = getComputedStyle(el);
        const linha = cs.display === "flex" && !/column/.test(cs.flexDirection);
        for (let i = 0; i < filhos.length; i++) {
          const c = filhos[i];
          const r = c.getBoundingClientRect();
          const direita = Math.round(r.right - rc.left);
          if (direita > W + 1 && !quebra.test(String(c.className)))
            problemas.push(`ESTOURA ${nome(c)}${texto(c)} até x=${direita} (tela ${W})`);
          // VAZA = um filho visível passa da caixa do pai (margem negativa não conta: ela é o
          // jeito de fazer espaço em linha que quebra, já que o UXP não tem `gap`)
          if (semRolagem(c)) {
            for (const f of Array.from(c.children)) {
              const rf = f.getBoundingClientRect();
              if ((rf.width > 0 || rf.height > 0) && rf.bottom > r.bottom + 1.5 && !quebra.test(String(f.className)))
                problemas.push(`VAZA ${nome(f)}${texto(f)} passa ${Math.round(rf.bottom - r.bottom)} px de ${nome(c)}`);
            }
          }
          if (i > 0) {
            const a = filhos[i - 1].getBoundingClientRect();
            const cruzaV = r.top < a.bottom - 1 && r.bottom > a.top + 1;
            const cruzaH = r.left < a.right - 1 && r.right > a.left + 1;
            if (cruzaV && cruzaH) problemas.push(`SOBREPÕE ${nome(filhos[i - 1])}${texto(filhos[i - 1])} × ${nome(c)}${texto(c)}`);
          }
          if (arvore)
            linhas.push(
              `${"  ".repeat(nivel)}${nome(c)} x=${Math.round(r.left - rc.left)} y=${Math.round(r.top - rc.top)} ${Math.round(r.width)}×${Math.round(r.height)}${texto(c)}`,
            );
          andar(c, nivel + 1);
        }
      };
      andar(document.querySelector(".screen") || document.body, 0);
      if (estilo) estilo.textContent = original;
      if (largura && link) linkPai.appendChild(link);
      if (tela) tela.removeAttribute("style");
      const cab = `largura ${W}px · altura do conteúdo ${corpo ? corpo.scrollHeight : "?"}px · ${problemas.length} problema(s)`;
      resolve([cab, ...problemas, ...(arvore ? ["", ...linhas] : [])].join("\n"));
    }), 150);
  })
