// FEATURE "take repetido por conteúdo": o Léo regrava a MESMA parte várias vezes SEM anunciar
// (o retakeDetect só pega quando ele fala "de novo"). Ex. real (2026-07-01, VSL Juliana): o lead
// dela foi regravado ~5× seguidas (11:30 / 12:57 / 13:47 / 14:34 / 14:50 / 15:05 / 15:35 / 16:55),
// a mesma frase "Guarda essa dúvida…" 5×. Isso são takes alternativos — o editor mantém o ÚLTIMO
// e descarta os anteriores.
//
// Detecção por SIMILARIDADE de conteúdo (shingles de trigrama + Jaccard), determinística, sem LLM:
// uma sentença é "versão anterior" se existe outra sentença PARECIDA mais adiante, separada no
// tempo (não gagueira colada) e dentro de uma janela de minutos (não uma peça diferente lá longe).
// Mantém a última cópia (ela não tem posterior parecida) e corta as anteriores.
//
// SEGURANÇA: cortar take inteiro é arriscado → entra como reason "repeticao" pra REVISÃO humana
// (a trava isDangerousCut/assessCutsClipImpact do painel destaca os grandes). Validado contra o
// bruto real: ~2,0 min de regravação num vídeo de 18,2 min, sem tocar em conteúdo único.
import type { Cut, Word } from "../../../../shared/types";
import { jaccard, shingles, splitSentences } from "./sentences";

export interface RepeatedTakeOptions {
  /** Similaridade mínima (Jaccard de trigramas) pra considerar a mesma fala. */
  minJaccard?: number;
  /** Palavras mínimas na sentença (frases curtas dão falso positivo). */
  minWords?: number;
  /** Separação mínima (s) entre as duas cópias — abaixo disso é gagueira colada, não retake. */
  minSepSec?: number;
  /** Janela máxima (s) pra procurar a cópia — além disso é provável outra peça, não o mesmo take. */
  maxGapSec?: number;
  /** Gap máximo (s) entre sentenças anteriores pra juntá-las num bloco só. */
  blockGapSec?: number;
}

/** Acha os takes repetidos e devolve cortes (reason "repeticao") das versões ANTERIORES. */
export function detectRepeatedTakeCuts(words: Word[], opts: RepeatedTakeOptions = {}): Cut[] {
  const minJ = opts.minJaccard ?? 0.5;
  const minW = opts.minWords ?? 6;
  const minSep = opts.minSepSec ?? 15;
  const maxGap = opts.maxGapSec ?? 300;
  const blockGap = opts.blockGapSec ?? 30;

  const sents = splitSentences(words, 3);
  const sh = sents.map((s) => shingles(s.toks));

  // 1. Marca cada sentença que tem uma cópia PARECIDA mais adiante (dentro da janela e separada).
  const anterior = new Array<boolean>(sents.length).fill(false);
  for (let i = 0; i < sents.length; i++) {
    if (sents[i].toks.length < minW) continue;
    for (let j = i + 1; j < sents.length; j++) {
      const dt = sents[j].startSec - sents[i].endSec;
      if (dt > maxGap) break; // sentenças ordenadas — nada mais cabe na janela
      if (dt < minSep) continue; // colada = gagueira, não retake
      if (sents[j].toks.length < minW) continue;
      if (jaccard(sh[i], sh[j]) >= minJ) {
        anterior[i] = true;
        break;
      }
    }
  }

  // 2. Junta sentenças "anteriores" contíguas (gap < blockGap) num bloco de take a descartar.
  const cuts: Cut[] = [];
  let i = 0;
  while (i < sents.length) {
    if (!anterior[i]) {
      i++;
      continue;
    }
    let j = i;
    let endSec = sents[i].endSec;
    let count = 1;
    while (j + 1 < sents.length && anterior[j + 1] && sents[j + 1].startSec - endSec < blockGap) {
      j++;
      endSec = sents[j].endSec;
      count++;
    }
    cuts.push({
      start: sents[i].startSec,
      end: endSec,
      reason: "repeticao",
      detail: `take repetido (${count} trecho${count > 1 ? "s" : ""}) — versão mantida adiante`,
    });
    i = j + 1;
  }
  return cuts;
}
