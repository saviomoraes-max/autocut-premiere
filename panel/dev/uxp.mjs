// Fala com o UXP Developer Tool (serviço em localhost:14001) pra recarregar o painel DENTRO do
// Premiere e medir o DOM de verdade — o Chromium do painel.html mente sobre o layout do UXP.
//
// Protocolo tirado do @adobe/uxp-devtools-core que vem dentro do próprio UXP Developer Tool:
// WebSocket em /socket/cli; cada pedido ao app vai embrulhado em {command:"proxy", clientId, message}.
//
//   node panel/dev/uxp.mjs list                 apps conectados e plugins carregados
//   node panel/dev/uxp.mjs load                 carrega (ou recarrega) o painel de panel/dist/
//   node panel/dev/uxp.mjs eval '<expressão>'   roda JS no painel e imprime o resultado (JSON)
//   node panel/dev/uxp.mjs evalfile <arq.js>    idem, com o JS num arquivo
//   node panel/dev/uxp.mjs medir [largura] [arvore]   acusa sobreposição/estouro na tela aberta
//   node panel/dev/uxp.mjs tela <nome>          abre uma tela (home, srt, config, erro, vazio,
//                                               revisar, texto, zoom — as 3 últimas com o bruto de teste)
//
// Precisa do UXP Developer Tool aberto e do Premiere conectado nele. Usa o WebSocket nativo do Node ≥ 22.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.resolve(aqui, "../dist/manifest.json");
const SESSAO = path.join(aqui, ".uxp-sessao.json");
const PORTA = Number(process.env.UXP_PORTA || 14001);

function conectar() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORTA}/socket/cli`);
    const apps = [];
    const pendentes = new Map();
    let proximo = 0;
    const api = {
      apps,
      pedir(clientId, message) {
        return new Promise((res, rej) => {
          const requestId = ++proximo;
          pendentes.set(requestId, { res, rej });
          ws.send(JSON.stringify({ command: "proxy", clientId, message, requestId }));
        });
      },
      fechar: () => ws.close(),
    };
    ws.onerror = () => reject(new Error(`UXP Developer Tool não respondeu em localhost:${PORTA}`));
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.command === "didAddRuntimeClient") apps.push({ id: d.id, app: d.app });
      else if (d.command === "didCompleteConnection") setTimeout(() => resolve(api), 300);
      else if (d.command === "reply") {
        const p = pendentes.get(d.requestId);
        if (!p) return;
        pendentes.delete(d.requestId);
        if (d.error || d.success === false) p.rej(new Error(d.error || d.errorMessage || "falhou"));
        else p.res(d);
      }
    };
  });
}

function appPremiere(api) {
  const a = api.apps.find((x) => x.app && x.app.appId === "premierepro");
  if (!a) throw new Error(`Premiere não está conectado ao UXP Developer Tool (apps: ${api.apps.map((x) => x.app?.appId).join(", ") || "nenhum"})`);
  return a;
}

async function carregar(api) {
  const a = appPremiere(api);
  const r = await api.pedir(a.id, {
    command: "Plugin",
    action: "load",
    params: { provider: { type: "disk", path: path.dirname(MANIFEST) } },
    breakOnStart: false,
  });
  fs.writeFileSync(SESSAO, JSON.stringify({ pluginSessionId: r.pluginSessionId }, null, 2));
  return r.pluginSessionId;
}

async function sessao(api) {
  if (fs.existsSync(SESSAO)) return JSON.parse(fs.readFileSync(SESSAO, "utf8")).pluginSessionId;
  return carregar(api);
}

// Chrome DevTools Protocol direto no painel: Runtime.evaluate com retorno por valor.
async function avaliar(api, expressao) {
  const a = appPremiere(api);
  let id = await sessao(api);
  let r;
  try {
    r = await api.pedir(a.id, { command: "Plugin", action: "debug", pluginSessionId: id });
  } catch {
    id = await carregar(api);
    r = await api.pedir(a.id, { command: "Plugin", action: "debug", pluginSessionId: id });
  }
  // vem como "ws=127.0.0.1:14001/socket/cdt/<sessão>" (formato de parâmetro do devtools://)
  const url = `ws://${r.wsdebugUrl.replace(/^ws=/, "")}`;
  return new Promise((resolve, reject) => {
    const cdt = new WebSocket(url);
    const contextos = [];
    let ctxId;
    const t = setTimeout(() => reject(new Error("CDP não respondeu em 30 s")), 30000);
    const enviar = (id, method, params = {}) => cdt.send(JSON.stringify({ id, method, params }));
    const avaliarAqui = (id, expression) =>
      enviar(id, "Runtime.evaluate", { expression, returnByValue: true, ...(ctxId ? { contextId: ctxId } : {}) });
    cdt.onerror = () => reject(new Error(`CDP falhou em ${url}`));
    // sem Runtime.enable o UXP responde "Cannot find default execution context"
    cdt.onopen = () => enviar(1, "Runtime.enable");
    // o UXP ignora awaitPromise: a expressão grava o resultado num global e a gente consulta até chegar
    const embrulho = `(() => { globalThis.__uxpDev = undefined;
      try { Promise.resolve((${expressao}\n)).then(
        (v) => { globalThis.__uxpDev = { ok: v }; },
        (e) => { globalThis.__uxpDev = { erro: String(e && e.stack || e) }; });
      } catch (e) { globalThis.__uxpDev = { erro: String(e && e.stack || e) }; }
      return 1; })()`;
    let consulta = 100;
    cdt.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (process.env.UXP_DEBUG) console.error("cdp:", ev.data.slice(0, 400));
      if (d.method === "Runtime.executionContextCreated") contextos.push(d.params.context);
      if (d.id === 1) setTimeout(() => { ctxId = contextos[0]?.id; avaliarAqui(2, embrulho); }, 200);
      if (d.id === 2) {
        if (d.error || d.result?.exceptionDetails) {
          clearTimeout(t); cdt.close();
          reject(new Error(d.error?.message || JSON.stringify(d.result.exceptionDetails).slice(0, 800)));
        } else setTimeout(() => avaliarAqui(++consulta, "globalThis.__uxpDev"), 50);
      }
      if (d.id > 100) {
        const v = d.result?.result?.value;
        if (v === undefined) { setTimeout(() => avaliarAqui(++consulta, "globalThis.__uxpDev"), 150); return; }
        clearTimeout(t); cdt.close();
        if (v.erro) reject(new Error(v.erro)); else resolve(v.ok);
      }
    };
  });
}

// Bruto de teste (5min36s, já no cache de transcrição do backend — abrir a revisão não gasta API).
const BRUTO = process.env.AUTOCUT_BRUTO || "/Volumes/Cyberpunk/vídeos/anúncios perpétuo/setembro/tela dividida/2E37D47E-A5AC-4571-8CAB-599EC20981FF.MP4";
const BRUTO_DUR = Number(process.env.AUTOCUT_BRUTO_DUR || 336);

/** JS que abre uma tela no painel pelo gancho __autocutDev (ver o construtor em ui/app.ts). */
function abrirTela(nome) {
  const simples = {
    home: "c.renderHome()",
    srt: "c.renderSrt()",
    config: "c.renderConfig()",
    vazio: "c.renderVazio()",
    erro: 'c.renderErro(new Error("Não consegui falar com o backend em http://localhost:7867 (conexão recusada ou sem resposta)."), "antes")',
    processar: 'c.renderProcessar("cut", () => {}); c.setStatus("Transcrevendo o áudio de 1 clipe(s) (sequência inteira)…")',
  };
  if (simples[nome]) return `(() => { const c = globalThis.__autocutDev; ${simples[nome]}; return "aberta: ${nome}"; })()`;
  const modo = { revisar: "cut", texto: "text", zoom: "zoom" }[nome];
  if (!modo) throw new Error(`tela desconhecida: ${nome}`);
  return `(async () => {
    const c = globalThis.__autocutDev;
    const ref = { mediaPath: ${JSON.stringify(BRUTO)}, inSec: 0, outSec: ${BRUTO_DUR}, fps: 30 };
    // o fetch do UXP falha com signal undefined — o painel sempre manda um
    const signal = new AbortController().signal;
    const t = await c.client.transcribe([ref], { signal });
    const a = await c.client.analyze({ transcript: t.transcript, segments: [ref], silence: { minSilenceSec: 0.35 }, signal });
    c.proposal = {
      segments: [{ audio: { clipRef: ref }, video: { clipRef: ref }, timelineStartSec: 0, timelineEndSec: ${BRUTO_DUR} }],
      source: "sequence", transcript: t.transcript, cuts: a.cuts, markers: a.markers || [],
      retakeSignals: a.retakeSignals || [], zoomPoints: a.zoomPoints || [],
      durationSec: t.transcript.durationSec, fps: 30,
    };
    c.receberProposta(${JSON.stringify(modo)});
    return "aberta: ${nome} (" + t.transcript.words.length + " palavras, " + a.cuts.length + " cortes)";
  })()`;
}

const [cmd, arg] = process.argv.slice(2);
const api = await conectar();
try {
  if (cmd === "list") {
    for (const a of api.apps) {
      console.log(`${a.app?.appId} ${a.app?.appVersion} (uxp ${a.app?.uxpVersion})`);
      if (a.app?.appId !== "premierepro") continue;
      const r = await api.pedir(a.id, { command: "Plugin", action: "list" });
      for (const p of r.plugins || []) console.log("  ", JSON.stringify(p));
    }
  } else if (cmd === "load") {
    console.log("carregado, sessão", await carregar(api));
  } else if (cmd === "medir") {
    const fn = fs.readFileSync(path.join(aqui, "medir.js"), "utf8").replace(/^\/\/.*$/gm, "").trim();
    const largura = Number(arg) || 0;
    const arvore = process.argv[4] === "arvore";
    console.log(await avaliar(api, `(${fn})(${largura}, ${arvore})`));
  } else if (cmd === "tela") {
    console.log(await avaliar(api, abrirTela(arg)));
  } else if (cmd === "eval" || cmd === "evalfile") {
    const js = cmd === "eval" ? arg : fs.readFileSync(arg, "utf8");
    const v = await avaliar(api, js);
    console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
  } else {
    console.log("uso: node panel/dev/uxp.mjs list | load | eval '<js>' | evalfile <arq.js>");
  }
} finally {
  api.fechar();
  setTimeout(() => process.exit(0), 100);
}
