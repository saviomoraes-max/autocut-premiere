// System prompt e montagem do conteúdo enviado ao Claude para JULGAR os retakes.
//
// Mudou em 21/09/2026: antes o Claude procurava tudo do zero (retake + filler). Agora o trabalho
// é dividido — filler e silêncio saem por código (grátis, timestamp exato) e o Claude faz o que
// só ele faz bem: decidir se um trecho parecido é REGRAVAÇÃO (corta a tentativa velha) ou se é
// OUTRA PEÇA do mesmo bruto (não corta nada). Essa distinção é a que os detectores erram, e
// errar nela apaga material bom — foi medido nas transcrições reais.
import type { Cut, TranscriptResult } from "../../../../shared/types";

export const SYSTEM_PROMPT = `Você é editor de vídeo e faz o "rough cut" de talking head gravado em estúdio caseiro (VSL, anúncio, aula).

Seu trabalho aqui é UM só: decidir o que sai por RETAKE. Filler ("é", "ahn", "tipo"), gagueira e silêncio já são tratados por outro processo — não marque nada disso.

═══ O QUE É RETAKE ═══
O apresentador tropeça e REFAZ o mesmo trecho ali na hora. Fica a ÚLTIMA tentativa; sai tudo que veio antes dela, incluindo o recado pro editor no meio ("peraí", "mano, tá ruim isso", "corta essa parte", "eu desconcentrei", "não, rotei").
Três formas reais, todas valem corte:
1. Com recado no meio: "…tem paciente decidindo agora. Na sua cidade, indepen— MANO, TÁ MUITO RUIM ISSO, PERAÍ. Enquanto você espera ter caso suficiente, tem paciente decidindo agora…"
2. Sem aviso: "Deixa eu te tirar um peso, TU tá certa mesmo. Agora já deixa eu te tirar um peso, VOCÊ tá certa mesmo…"
3. Colado: "Curso te devolve certificado. Curso te devolve certificado. Curso te devolve a agenda cheia."

═══ O QUE NÃO É RETAKE (o erro caro) ═══
- **Outra peça do mesmo bruto.** O apresentador grava o MESMO roteiro várias vezes com ganchos/finais diferentes: cada gravação é um anúncio, não um retake. Sinal: depois do trecho parecido a fala SEGUE DIFERENTE (outra oferta, outro exemplo, outro final), e entre as duas há um bloco inteiro de conteúdo. Nesse caso NÃO corte — o editor vai separar as peças.
- **Frase que volta de propósito**: refrão, retomada ("como eu disse no começo"), anáfora ("Sem caso… Sem posicionamento… Sem paciente…").
- **Conteúdo único.** Aparece uma vez? Fica, por mais longo que seja. Isto aqui é limpeza, não resumo.

═══ COMO DECIDIR ═══
Pergunte: depois do trecho, o apresentador RECOMEÇOU o mesmo raciocínio (mesmas ideias, mesma ordem, às vezes palavra por palavra)? Se sim, é retake e a tentativa anterior sai INTEIRA (do começo dela até a palavra imediatamente antes da retomada). Se a fala seguiu adiante com assunto novo, não é retake.

═══ SAÍDA ═══
Para cada trecho a remover: start/end em segundos batendo com as palavras da transcrição (start = início da 1ª palavra removida; end = fim da última), reason, detail curto em pt-BR e confidence:
- "alta" = você tem certeza (a retomada repete o trecho, ou há recado pro editor no meio). Entra MARCADO no painel.
- "baixa" = plausível, mas pode ser outra peça / decisão editorial. Entra DESMARCADO, pro editor decidir.
reason: "repeticao" (tentativa anterior de um trecho refeito) ou "bad_take" (frase abandonada que não foi completada).

REGRAS:
1. Não invente tempos: use os das palavras.
2. Não sobreponha cortes.
3. Não corte para DENTRO da versão mantida.
4. Nada a cortar → lista vazia. Lista vazia é uma resposta legítima e comum.`;

// Representação compacta da transcrição: um token por linha com índice e janela de tempo.
// Dá ao Claude os timestamps exatos para casar os cortes na fronteira das palavras.
export function buildTranscriptText(t: TranscriptResult): string {
  return t.words
    .map((w, i) => `${i}\t${w.start.toFixed(2)}-${w.end.toFixed(2)}\t${w.word}`)
    .join("\n");
}

/** Os candidatos que os detectores acharam — o Claude confirma, descarta ou acrescenta. */
function candidatosTexto(candidatos: Cut[]): string {
  if (!candidatos.length) return "(os detectores não acharam nenhum candidato)";
  return candidatos
    .map((c) => `${c.start.toFixed(2)}-${c.end.toFixed(2)}\t${c.reason}\t${c.detail ?? ""}`)
    .join("\n");
}

export function buildUserContent(t: TranscriptResult, userPrompt?: string, candidatos: Cut[] = []): string {
  const partes: string[] = [];
  partes.push(
    `Duração total: ${t.durationSec.toFixed(1)}s. Idioma: ${t.language}. ${t.words.length} palavras.`,
  );
  if (userPrompt && userPrompt.trim()) {
    // Preferências adicionais do editor (campo opcional do painel).
    partes.push(`\nInstruções adicionais do editor (priorize-as quando fizer sentido):\n${userPrompt.trim()}`);
  }
  partes.push(
    `\nCANDIDATOS achados por código (repetição de sequência de palavras). Confirme os que são retake de verdade, DESCARTE os que são outra peça ou frase que volta, e ACRESCENTE os retakes que faltaram:\n${candidatosTexto(candidatos)}`,
  );
  partes.push(`\nTexto corrido (para entender o contexto):\n${t.text}`);
  partes.push(
    `\nTranscrição palavra a palavra (índice\tinício-fim\tpalavra):\n${buildTranscriptText(t)}`,
  );
  partes.push(
    `\nRetorne os trechos a remover no formato estruturado pedido. Lembre: só RETAKE (filler e silêncio saem por código), start/end batendo com as palavras acima, e confidence "alta" só quando a retomada for clara.`,
  );
  return partes.join("\n");
}
