// Banco de teste do detector de trecho refeito, sobre as transcrições REAIS já em cache
// (~/.autocut/transcripts) — sem gastar API e sem depender do disco dos brutos.
//
//   npx tsx server/scripts/testar_retakes.ts            # resumo das 60 transcrições
//   npx tsx server/scripts/testar_retakes.ts <prefixo>  # detalhe de uma (mostra cada corte)
//
// Imprime, por transcrição: quanto o detector NOVO cortaria, quanto o antigo (take repetido por
// sentença) cortaria, e o texto de cada corte — que é o que dá pra conferir com o olho.
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectRetakeSpanCuts } from "../src/services/analysis/retakeSpanDetect";
import { detectRepeatedTakeCuts } from "../src/services/analysis/repeatedTakeDetect";
import { detectFalseStartCuts } from "../src/services/analysis/falsoComecoDetect";
import { detectRetakeSignals } from "../src/services/analysis/retakeDetect";
import type { Cut, Word } from "../../shared/types";

const DIR = path.join(os.homedir(), ".autocut", "transcripts");
const filtro = process.argv[2] ?? "";

interface Cache {
  transcript?: { words?: Word[]; durationSec?: number };
}

function tempo(s: number): string {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

function soma(cuts: Cut[]): number {
  return cuts.reduce((a, c) => a + (c.end - c.start), 0);
}

const arquivos = readdirSync(DIR).filter((f) => f.endsWith(".json") && f.startsWith(filtro));
let totalNovo = 0;
let totalAntigo = 0;
const linhas: string[] = [];

for (const f of arquivos) {
  let dados: Cache;
  try {
    dados = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Cache;
  } catch {
    continue;
  }
  const words = dados.transcript?.words ?? [];
  if (words.length < 50) continue;
  const dur = dados.transcript?.durationSec ?? words[words.length - 1].end;

  const novos = detectRetakeSpanCuts(words);
  const antigos = detectRepeatedTakeCuts(words);
  const falsos = detectFalseStartCuts(words);
  const sinais = detectRetakeSignals(words);
  totalNovo += soma(novos);
  totalAntigo += soma(antigos);

  linhas.push(
    `${f.slice(0, 10)}  ${(dur / 60).toFixed(0).padStart(3)}min  ${String(words.length).padStart(5)}p  ` +
      `refeito: ${String(novos.length).padStart(3)} (${soma(novos).toFixed(0)}s)  ` +
      `repetido: ${String(antigos.length).padStart(3)} (${soma(antigos).toFixed(0)}s)  ` +
      `falso começo: ${String(falsos.length).padStart(2)}  sinais: ${sinais.length}`,
  );

  if (filtro) {
    for (const c of novos) {
      console.log(`\n[${tempo(c.start)} → ${tempo(c.end)}] ${(c.end - c.start).toFixed(1)}s`);
      console.log(`  ${c.detail}`);
    }
  }
}

console.log(linhas.sort().join("\n"));
console.log(`\ntotal: trecho refeito ${(totalNovo / 60).toFixed(1)} min · take repetido ${(totalAntigo / 60).toFixed(1)} min · ${arquivos.length} transcrições`);
