// Mede o que cada opção do Scribe v2 entrega NO MESMO áudio — pra decidir a detecção de retake
// com dado, não com achismo. Guarda a resposta crua de cada rodada e imprime um resumo.
//
//   node server/scripts/scribe_opcoes.mjs <bruto.mp4|wav> [pasta-de-saida]
//
// A chave sai do Keychain (serviço elevenlabs-api-key) e fica só em memória — nunca em argumento
// de comando (visível no `ps`), nem em arquivo. Cada rodada custa uma transcrição do áudio todo.
import { execFile } from "node:child_process";
import { mkdirSync, openAsBlob, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const URL_STT = "https://api.elevenlabs.io/v1/speech-to-text";

const entrada = process.argv[2];
if (!entrada) {
  console.error("uso: node server/scripts/scribe_opcoes.mjs <bruto.mp4|wav> [pasta-de-saida]");
  process.exit(1);
}
const saida = process.argv[3] ?? path.join(path.dirname(entrada), "scribe-opcoes");

/** Vocabulário do corte: o que o chefe fala quando manda refazer, e os marcadores falados. */
const KEYTERMS = [
  "de novo", "mais uma", "mais uma vez", "outra vez", "do começo", "começando de novo",
  "vou repetir", "repetindo", "deixa eu repetir", "deixa eu fazer de novo", "corta isso",
  "corta essa parte", "peraí", "pera", "espera", "errei", "me perdi", "falei errado",
  "cortar", "corte", "gravando", "gravei", "take", "segura", "voltei",
  "lead", "corpo", "anúncio", "gancho", "cta", "bloco", "prova",
];

async function chave() {
  const { stdout } = await exec("/usr/bin/security", ["find-generic-password", "-s", "elevenlabs-api-key", "-w"]);
  const k = stdout.trim();
  if (!k) throw new Error("chave do ElevenLabs não encontrada no Keychain");
  return k;
}

/** Áudio mono 16 kHz — o mesmo pré-processo do backend, pra comparar maçã com maçã. */
async function paraWav(origem) {
  if (origem.toLowerCase().endsWith(".wav")) return origem;
  mkdirSync(saida, { recursive: true });
  const wav = path.join(saida, "audio-16k.wav");
  if (existsSync(wav) && statSync(wav).size > 0) return wav;
  console.log("extraindo áudio…");
  await exec("ffmpeg", ["-y", "-i", origem, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], {
    maxBuffer: 1 << 26,
  });
  return wav;
}

async function rodada(nome, wav, k, campos) {
  const form = new FormData();
  form.append("file", await openAsBlob(wav, { type: "audio/wav" }), "audio.wav");
  form.append("model_id", "scribe_v2");
  form.append("language_code", "pt");
  form.append("timestamps_granularity", "word");
  for (const [chaveCampo, valor] of campos) form.append(chaveCampo, valor);
  const t0 = Date.now();
  const res = await fetch(URL_STT, { method: "POST", headers: { "xi-api-key": k }, body: form });
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res.ok) {
    console.log(`${nome}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    return null;
  }
  const dados = await res.json();
  mkdirSync(saida, { recursive: true });
  writeFileSync(path.join(saida, `${nome}.json`), JSON.stringify(dados));
  console.log(`\n=== ${nome} (${seg}s)`);
  resumir(dados);
  return dados;
}

function resumir(d) {
  const ws = d.words ?? [];
  const palavras = ws.filter((w) => w.type === "word");
  const eventos = ws.filter((w) => w.type === "audio_event");
  const falantes = new Map();
  for (const w of palavras) falantes.set(w.speaker_id ?? "—", (falantes.get(w.speaker_id ?? "—") ?? 0) + 1);
  const lp = palavras.map((w) => w.logprob).filter((v) => typeof v === "number").sort((a, b) => a - b);
  const pct = (f) => (lp.length ? lp[Math.floor(lp.length * f)].toFixed(2) : "—");
  const cortadas = palavras.filter((w) => /-+$/.test(w.text));
  const texto = palavras.map((w) => w.text).join(" ").toLowerCase();
  const achar = (re) => (texto.match(re) ?? []).length;
  console.log(`palavras: ${palavras.length} · duração: ${(d.audio_duration_secs ?? 0).toFixed(1)}s · idioma: ${d.language_code} (${d.language_probability ?? "—"})`);
  console.log(`falantes: ${[...falantes.entries()].map(([k, n]) => `${k}=${n}`).join(" ")}`);
  console.log(`eventos de áudio (${eventos.length}): ${eventos.slice(0, 12).map((e) => `${e.text}@${(e.start ?? 0).toFixed(1)}`).join(" ") || "nenhum"}`);
  console.log(`logprob: mín ${pct(0)} · p5 ${pct(0.05)} · p25 ${pct(0.25)} · mediana ${pct(0.5)} · abaixo de −0,5: ${lp.filter((v) => v < -0.5).length} · abaixo de −1: ${lp.filter((v) => v < -1).length}`);
  console.log(`fala cortada ("--"): ${cortadas.length} ${cortadas.slice(0, 8).map((w) => `${w.text}@${(w.start ?? 0).toFixed(1)}`).join(" ")}`);
  console.log(`"de novo": ${achar(/de novo/g)} · "mais uma": ${achar(/mais uma/g)} · "peraí|pera": ${achar(/pera[íi]?\b/g)} · "corta": ${achar(/\bcorta\b/g)} · "errei": ${achar(/errei/g)}`);
}

const k = await chave();
const wav = await paraWav(entrada);
console.log("áudio:", wav);

const rodadas = [
  ["A-atual", [["no_verbatim", "false"], ["tag_audio_events", "true"], ["diarize", "false"]]],
  ["B-diarize", [["no_verbatim", "false"], ["tag_audio_events", "true"], ["diarize", "true"]]],
  ["C-keyterms", [["no_verbatim", "false"], ["tag_audio_events", "true"], ["diarize", "true"], ...KEYTERMS.map((t) => ["keyterms", t])]],
  ["D-seed1", [["no_verbatim", "false"], ["tag_audio_events", "true"], ["diarize", "true"], ["temperature", "0"], ["seed", "42"]]],
  ["D-seed2", [["no_verbatim", "false"], ["tag_audio_events", "true"], ["diarize", "true"], ["temperature", "0"], ["seed", "42"]]],
];

const feitas = {};
for (const [nome, campos] of rodadas) feitas[nome] = await rodada(nome, wav, k, campos);

// determinismo: as duas rodadas com o mesmo seed dão o mesmo texto?
const t = (d) => (d?.words ?? []).filter((w) => w.type === "word").map((w) => w.text).join(" ");
if (feitas["D-seed1"] && feitas["D-seed2"]) {
  const a = t(feitas["D-seed1"]), b = t(feitas["D-seed2"]);
  console.log(`\nseed 42 repetido: ${a === b ? "MESMO texto" : "textos DIFERENTES"} (${a.split(" ").length} vs ${b.split(" ").length} palavras)`);
}
if (feitas["A-atual"] && feitas["C-keyterms"]) {
  console.log(`keyterms mudou o texto? ${t(feitas["A-atual"]) === t(feitas["C-keyterms"]) ? "não" : "sim"}`);
}
console.log(`\nrespostas cruas em ${saida}`);
