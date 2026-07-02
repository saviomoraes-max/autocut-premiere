# TODOs de verificação da API UXP (Premiere Pro)

As assinaturas usadas em `panel/src/premiere/` foram conferidas na doc oficial
(https://developer.adobe.com/premiere-pro/uxp/ppro-reference/) e o código passa no
`tsc`. Mas estas partes só dão pra confirmar **rodando no Premiere ≥ 25.6**. Validar
cada item antes de considerar a aplicação dos cortes "pronta de produção".

## 1. Cast de ProjectItem → ClipProjectItem  (`selection.ts`, `applyCuts.ts`)
- Uso: `ClipProjectItem.cast(projectItem)`.
- Confirmar o nome exato do método de cast na doc de `ProjectItem`/`ClipProjectItem`
  (pode ser `cast`, `casted`, ou acesso por propriedade). Ajustar se necessário.

## 2. Membros de `Constants`  (`applyCuts.ts`)
- Uso: `Constants.MediaType.ANY`, `Constants.TrackItemType.CLIP`.
- Conferir os nomes/valores exatos em https://.../ppro-reference/constants/.
  Se forem outros (ex.: `MediaType.Any`, ou um inteiro), corrigir.

## 3. Interleave de in/out + overwrite numa só transação  (`applyCuts.ts`) — CONFIRMADO e RESOLVIDO
- BUG CONFIRMADO no Premiere (2026-06-18): com `createSetInOutPointsAction(in,out)` +
  `createOverwriteItemAction(...)` na MESMA `executeTransaction`, o overwrite lê o in/out
  ANTIGO — cada fatia saía com a origem da fatia ANTERIOR, gerando fragmentos extras
  (74 itens p/ 51 planejadas) e dessincronia. Diagnosticado via introspecção (`built-sequence`):
  plano fatia#1 `120.637→126.51` mas saiu `111.361→117.234` (in-point da fatia#0).
- FIX: `setInOut` numa transação e `overwrite` em OUTRA (separadas), por fatia. A fatia 0
  (`createSequenceFromMedia`, já separada) sempre saiu certa — confirmou a causa.

## 4. `createSequenceFromMedia` precisa de lock/transação?  (`applyCuts.ts`)
- Está sendo chamado direto (retorna `Sequence`, não `Action`).
- Confirmar se precisa rodar dentro de `lockedAccess` ou `executeTransaction`.

## 5. `getSelection()` mistura vídeo e áudio  (`selection.ts`) — RESOLVIDO por dedup
- `getMediaType()` devolve um **Guid** (UUID), NÃO o enum `Constants.MediaType` — então
  não dá pra comparar direto com `MediaType.VIDEO`. Em vez de filtrar por tipo,
  **deduplicamos por (mediaPath, inSec, outSec)**: vídeo+áudio linkados têm a mesma chave
  e o mesmo `ProjectItem` do bin, então colapsam num segmento só. Validar no Premiere que
  a dedup realmente colapsa o par linkado (e que `getProjectItem()` do item de áudio
  aponta pro mesmo master clip — assumido, não confirmado).

## 8. Modo ACHATADO — leitura de múltiplos clips  (`selection.ts`) — NÃO VALIDADO
- `seq.getSelection()` → `getTrackItems()` retornando `Array<Video|AudioClipTrackItem>`
  com vários itens (hoje o código usa todos, não só `[0]`).
- Sequência inteira: `seq.getVideoTrackCount()` + `seq.getVideoTrack(i)` +
  `track.getTrackItems(Constants.TrackItemType.CLIP, false)`. Atenção: o `.d.ts` tipa
  `VideoTrack.getTrackItems` como retorno **síncrono** (`VideoClipTrackItem[]`, sem
  Promise) — usamos `await` defensivo (inócuo se vier Promise). Confirmar no runtime.
- `item.getStartTime()` (posição na sequência, pra ordenar) e `item.getInPoint()/getOutPoint()`
  (in/out na origem). Confirmar que `getInPoint/getOutPoint` do track item são mesmo o
  trecho da MÍDIA DE ORIGEM (e não posição na sequência).
- Clips de tracks de vídeo stackadas (V1+V2 no mesmo tempo) não são desambiguados —
  o uso primário é uma track de vídeo só. Documentar como limitação.

## 9. Montagem multi-fonte  (`applyCuts.ts`) — NÃO VALIDADO
- `createSequenceFromMedia` usa a 1ª fatia pros settings; as demais fatias podem ser de
  **mídias diferentes** (`createInsertProjectItemAction(projectItem, ...)` com projectItems
  distintos). Confirmar que inserir projectItems de mídias diferentes na mesma sequência
  funciona e respeita o in/out setado logo antes, fatia a fatia.

## 10. Pares vídeo+áudio (áudio A1 separado)  (`selection.ts`/`applyCuts.ts`) — RISCO ATUAL
- Leitura da A1: `seq.getAudioTrackCount()` + `getAudioTrack(0)` +
  `track.getTrackItems(TrackItemType.CLIP, false)` → `AudioClipTrackItem[]`. Pareamento
  áudio↔vídeo por **maior sobreposição de `getStartTime/getEndTime`** na timeline.
  Confirmar que `AudioClipTrackItem.getInPoint/getOutPoint` são o trecho da MÍDIA de áudio.
- **Montagem dual-track (fase 3)**: depois de deitar o vídeo no V1 (que traz o áudio de
  câmera junto no A1), `createOverwriteItemAction(audioProjectItem, tt(pos), 0, 0)`
  sobrescreve o A1 com o áudio real. PONTOS A CONFIRMAR no Premiere:
  (a) overwrite de um projectItem **só-áudio** com `videoTrackIndex=0` NÃO mexe no vídeo do V1;
  (b) a posição `pos` (capturada via `getEndTime` antes de cada insert de vídeo) casa
      exatamente com onde o vídeo ficou (sem drift de 1 frame);
  (c) se a duração do áudio real ≠ duração do vídeo (retime/sync imperfeito), pode sobrar
      sliver de áudio de câmera — avaliar `createRemoveItemsAction` no A1 antes do overwrite.
  Se brigar, ligar `applyRoughCut(.., { videoOnly: true })` (sai vídeo + áudio de câmera).

## 6. fps a partir de `getTimebase()`  (`selection.ts`)
- Assumimos `fps = 254016000000 / Number(getTimebase())` (timebase = ticks/frame).
- Confirmar a semântica do timebase; se houver API direta de frame rate, usar.

## 7. Versão mínima do Premiere
- Toda a API de edição (`SequenceEditor`, `createSetInOutPointsAction`, etc.) é
  min version 25.0; UXP saiu do beta no 25.6. Confirmar que o Premiere de teste é ≥ 25.6.
