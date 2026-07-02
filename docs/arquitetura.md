# Arquitetura — AutoCut

## Visão geral
Dois processos que conversam por HTTP em localhost:

- **Painel UXP** (dentro do Premiere): UI + leitura do clip selecionado + montagem da
  sequência rough cut.
- **Backend Node local**: extração de áudio (ffmpeg), transcrição (WhisperX/OpenAI),
  detecção de silêncio (ffmpeg silencedetect) e análise dos cortes (Claude).

## Fluxo Auto-Edit (modo ACHATADO — pares vídeo+áudio)
O Auto-Edit roda em **vários clipes de uma vez** e cada clipe é um **par linkado**: vídeo
no V1 + áudio no A1. O **áudio do A1 é a fonte da transcrição** (pode ser um arquivo
SEPARADO, vinculado ao vídeo — não o áudio embutido da câmera). Escopo: se há clipes
selecionados, processa só os pares cobertos pela seleção; senão, a **sequência inteira**.
O áudio de todos os pares é concatenado num **stream contínuo** ("achatado") e
transcrito/analisado uma vez — o Claude vê a narrativa inteira e pega repetição/bad-take
entre clipes. O caso de 1 clipe normal (áudio = áudio do próprio vídeo) é o mesmo caminho,
com `audio.mediaPath == video.mediaPath`.

1. `selection.ts → readSegments()` lê os clipes de **áudio da A1** (`getAudioTrack(0)`),
   pareia cada um com o clipe de **vídeo** (V1) de maior sobreposição na timeline, e ordena
   por posição → `TimelineSegment[] { audio, video, timelineStart/End }` (cada `audio`/`video`
   = `SourceRef` com `ClipRef` + handles duráveis do bin).
2. `POST /transcribe { segments: ClipRef[] }` com os **ClipRefs do ÁUDIO** → backend extrai
   cada `[inSec,outSec]` em WAV 16k mono e **concatena** (`concatWavsToWav`). Transcreve
   word-level; timestamps relativos ao stream achatado (0 = início do 1º clipe).
3. `POST /analyze { transcript, segments }` → silêncio (acústico no WAV achatado) ‖ Claude
   (filler/repetição/bad-take sobre a transcrição inteira), depois `mergeCuts`. `cuts[]` em
   tempo **achatado**.
4. Revisão humana no painel (toggle por corte).
5. `layoutSegments` (durações do ÁUDIO) + `computeKeeps(.., totalSec, { sourceOffsetSec: 0 })`
   → keeps em tempo achatado, snapados a frame.
6. `mapKeepsToSourceSlices` (`shared/segments.ts`) → cada keep vira fatias com **offset
   RELATIVO ao segmento**, cortando em cada fronteira (keep que cruza dois clipes = 2 fatias).
7. Re-lê FRESCO e valida que os pares são os mesmos (mídia+in/out de vídeo E áudio).
8. Para cada fatia: origem do vídeo = `vIn + rel`, origem do áudio = `aIn + rel` (andam 1:1).
   `applyRoughCut(slices)` monta em 3 fases: (1) `createSequenceFromMedia` do 1º vídeo
   (settings), (2) anexa as demais fatias de vídeo no fim, (3) **sobrescreve** (`createOverwriteItemAction`,
   sem ripple) o áudio real no A1 em cada posição — trocando o áudio de câmera pelo do A1.
   Tudo dentro de `lockedAccess(executeTransaction(...))`, uma transação por item.
   Flag `videoOnly` pula a fase 3 (fallback).

## Decisões-chave
- **UXP, não CEP** — CEP foi "superseded" no Premiere 25.6; novos projetos = UXP.
- **Rough cut, não razor** — a API UXP não tem split/razor programático; montamos uma
  sequência só com os trechos mantidos. Não-destrutivo.
- **Silêncio acústico, não por gap de palavra** — o forced-align do WhisperX absorve a
  pausa na palavra anterior, então o gap entre palavras é pouco confiável; usamos o
  `silencedetect` do ffmpeg.
- **Structured outputs + adaptive thinking** no Claude — JSON garantido sem o conflito de
  `tool_choice` forçado com thinking.

## Domínios de tempo (cuidado — três deles)
- **ACHATADO**: segundos no stream concatenado (0 = início do 1º clip). É o domínio da
  transcrição, do silêncio e dos cortes que voltam do backend.
- **MÍDIA DE ORIGEM**: segundos dentro do arquivo de cada clip (inSec..outSec do track item).
  É onde o rough cut aponta; `mapKeepsToSourceSlices` faz a ponte achatado → origem.
- **SEQUÊNCIA**: posição na timeline (`getStartTime`). Só ordena os clips; depois disso o
  stream achatado ignora os gaps entre eles.
- No caso de 1 clip, o tempo achatado começa em 0 e a origem = `inSec + tempo achatado` —
  exatamente o comportamento antigo (`sourceOffsetSec` virou parte do mapeamento por segmento).
