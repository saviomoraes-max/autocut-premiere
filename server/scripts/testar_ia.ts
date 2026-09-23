// Mede o julgamento de retake pela IA numa transcrição JÁ EM CACHE (~/.autocut/transcripts),
// sem áudio e sem re-transcrever. Imprime tempo, custo real e os maiores cortes com contexto.
//
//   npx tsx --env-file=server/.env server/scripts/testar_ia.ts <prefixo-do-arquivo>
//
// Cada rodada CHAMA A API e custa (medido em 21/09: US$ 0,27 num bruto de 5,6 min; US$ 0,50 em
// 14,8 min — com ANTHROPIC_EFFORT=max).
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { analyzeSemanticCuts } from "/Volumes/SSD kenipe/agentes/videos reconecta/autocut-premiere/server/src/services/analysis/claudeClient";
import { detectRetakeSpanCuts } from "/Volumes/SSD kenipe/agentes/videos reconecta/autocut-premiere/server/src/services/analysis/retakeSpanDetect";
import { detectFalseStartCuts } from "/Volumes/SSD kenipe/agentes/videos reconecta/autocut-premiere/server/src/services/analysis/falsoComecoDetect";
const DIR = path.join(os.homedir(), ".autocut", "transcripts");
const f = readdirSync(DIR).find((x) => x.startsWith(process.argv[2]))!;
const d = JSON.parse(readFileSync(path.join(DIR, f), "utf8"));
const t = { ...d.transcript, engine: "elevenlabs" as const };
const cand = [...detectRetakeSpanCuts(t.words), ...detectFalseStartCuts(t.words)];
console.log(`${t.words.length} palavras · ${(t.durationSec/60).toFixed(1)} min · ${cand.length} candidatos do código`);
async function main() {
const t0 = Date.now();
  const userPrompt = process.argv[3];
  if (userPrompt) console.log(`instrução do editor: "${userPrompt}"`);
  const cuts = await analyzeSemanticCuts(t, { candidatos: cand, userPrompt });
  console.log(`IA: ${cuts.length} cortes em ${((Date.now()-t0)/1000).toFixed(0)}s · total ${(cuts.reduce((s,c)=>s+c.end-c.start,0)).toFixed(0)}s`);
  for (const c of cuts.sort((a,b)=> (b.end-b.start)-(a.end-a.start)).slice(0, 8)) {
    const dentro = t.words.filter((w: any) => w.start >= c.start && w.end <= c.end).map((w: any) => w.word).join(" ");
    const depois = t.words.filter((w: any) => w.start >= c.end).slice(0, 18).map((w: any) => w.word).join(" ");
    console.log(`\n[${c.start.toFixed(0)}s +${(c.end-c.start).toFixed(1)}s] ${c.reason} ${c.review ? "DESMARCADO" : "marcado"}\n  ${(c.detail??"").slice(0,120)}\n  CORTA: ${dentro.slice(0,150)}\n  FICA:  ${depois.slice(0,120)}…`);
  }
  
}
void main();
