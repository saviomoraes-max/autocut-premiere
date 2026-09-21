# CLAUDE.md — AutoCut (plugin do Premiere Pro)

Guia para o Claude Code trabalhar neste repositório. Comentários de código e commits em
português do Brasil.

## O que é

Painel UXP para o Adobe Premiere Pro 2026 (26.x) que faz o rough cut de brutos de talking head:
transcreve, corta silêncio, hesitação e falso começo, separa o bruto em sequências pelos
marcadores falados ("lead 1", "corpo 2"), aplica punch-in (Auto-Zoom), edita por texto e exporta
SRT em dois estilos (Reels, palavra por palavra; Cinema, frase inteira em até 2 linhas).

Duas partes que conversam por HTTP em `http://localhost:7867`:

| Pasta | O que é | Roda onde |
|---|---|---|
| `panel/` | UI do plugin (TypeScript + webpack → `panel/dist/`) | dentro do Premiere |
| `server/` | backend Node (transcrição, análise, SRT) | LaunchAgent no Mac |
| `shared/` | tipos e lógica pura usados pelos dois | — |

Transcrição: ElevenLabs Scribe v2 (padrão desde a v2) ou WhisperX local (`TRANSCRIBER` no
`server/.env`). Tags: `v1-whisperx` e `v2-elevenlabs`.

## Onde o design mora

Redesign "1a Quieto" (handoff de 21/09/2026): três etapas explícitas — Configurar → Processar →
Revisar — mais Editar por texto, Auto-Zoom, Exportar SRT, Config, Erro e Vazio.

- `panel/src/styles.css` — todo o visual. Tokens no topo (`--bg`, `--ink`…`--ink-10`, `--ok`,
  `--danger`), tirados do handoff. `@media (max-width: 720px)` e `(max-width: 440px)` fazem o
  painel encaixado (300 px) funcionar; acima disso sai idêntico ao design de 980 px.
- `panel/src/ui/kit.ts` — as peças: `make()`, botão, caixa de marcação, chip, stepper,
  contador de duração, grupo segmentado, rodapé fixo, e as duas animações.
- `panel/src/ui/app.ts` — a lógica e as telas: `renderHome`, `renderProcessar`, `renderRevisar`,
  `renderTexto`, `renderZoom`, `renderSrt`, `renderConfig`, `renderErro`, `renderVazio`,
  `renderNada`, `renderDiag`.
- A paleta é a do handoff (quase monocromática), NÃO a da marca. Se um dia alinhar com a
  identidade RECONECTA, a única fonte dos tokens é `design-system/core/tokens.json` no
  repositório `saviomoraes-max/carrosseis` — referencie de lá, não invente cor.
- Ficaram de fora de propósito (o handoff marca como dependentes de backend que não existe):
  play do trecho, prévia ao vivo da transcrição, respiro por corte.

## Regras do UXP (o painel roda num Chromium antigo e restrito)

Cada uma destas já quebrou o painel antes — estão comentadas no código onde aconteceram.

- **Sem `innerHTML`.** Monte com `make()`.
- **`style` via atributo:** `e.setAttribute("style", "...")`. O UXP não aceita `e.style = "..."`.
- **Nunca o atalho `inset`.** Use `top`, `right`, `bottom` e `left` explícitos — com `inset` o
  elemento fica sem altura e nada rola.
- **Evite `position: sticky` e `position: fixed` para layout.** No UXP eles não reservam espaço e
  o conteúdo passa por baixo (o menu cobria o texto no editor). O padrão que funciona é o casco
  `.screen` (`kit.ts` → `screen()`): ele ocupa a janela, o `.screen-body` rola com
  `flex: 1 1 auto; min-height: 0; overflow-y: auto`, e o rodapé fica estático no fim.
- **Rede só por nome:** `localhost`, nunca `127.0.0.1` (o UXP bloqueia IP).
- **O CSS vai embutido no JS** (`panel/src/index.ts` injeta o `styles.css` como `<style>`).
  Mudou o CSS → rebuild. O console do UXP fica escondido; erro de montagem aparece no próprio
  painel.

Conferido na referência oficial de CSS do UXP do Premiere (repositório `AdobeDocs/uxp-premiere-pro`)
em 21/09/2026:

- **Sem `display: grid`** — a Adobe diz com todas as letras que não existe. Use flex.
- **Sem `:not()`** — não está na lista de pseudo-classes (tem `hover`, `focus`, `disabled`,
  `last-child`, `first-child`, `nth-child`…). Use classes explícitas.
- **`@keyframes`, `animation` e `transform` não constam da lista.** As animações rodam por JS em
  `kit.ts` (`animarProcesso`), mexendo só em `margin-left` e `opacity`.
- **`box-sizing` não consta** — campo com largura cheia usa `calc(100% - padding - borda)`.
- **`@media (max-width)` é suportado** (UXP 4.1+).
- **Fonte:** `system-ui` vem antes de `-apple-system` — medido no Chromium, `-apple-system` no
  peso 500 cai numa fonte condensada errada.

## Build e teste do painel

```bash
npm --prefix panel ci            # primeira vez
npm --prefix panel run build     # gera panel/dist/
(cd panel && npx tsc --noEmit)   # typecheck
```

No Premiere: UXP Developer Tool → linha do AutoCut → **Reload**. Mudança só de visual não
precisa mexer no backend. Mudança no `manifest.json` (permissão, tamanho) pode não entrar com
Reload — aí é **Unload** e **Load** de novo.

## Ver o painel fora do Premiere

`panel/dev/painel.html` carrega o painel compilado num navegador com o Premiere SIMULADO (uma
sequência com um clipe) e o backend de verdade. Dois roteiros com Playwright:

```bash
npm --prefix panel run build
python3 panel/dev/fotografar.py <bruto.mp4> <duracao_s> [porta]   # fotos em panel/dev/fotos/, 980 e 300 px
python3 panel/dev/interacoes.py <bruto.mp4> <duracao_s> [porta]   # 18 conferências de comportamento
```

É Chromium, não UXP: serve pra layout e comportamento. A palavra final é o Premiere.

## Não mexer sem necessidade

- `shared/types.ts` é o contrato entre painel e backend — mudar um lado sem o outro quebra a rota.
- `server/` está em produção. Nada de mudar rota, detector ou transcrição num trabalho de design.
- `panel/src/premiere/` fala com a API do Premiere (tempo de vida de objeto no PR 2026 é frágil —
  ver histórico do git). Fora de escopo para ajuste visual.

## Como uma mudança chega ao Premiere (são três cópias)

1. **GitHub** (`saviomoraes-max/autocut-premiere`) — onde o trabalho no Claude Code acontece.
2. **SSD** (`/Volumes/SSD kenipe/agentes/videos reconecta/autocut-premiere`) — o Premiere carrega
   o painel DAQUI (`panel/dist/manifest.json`). Depois de mudar no GitHub:
   `git pull origin master` + `npm --prefix panel run build` nesta cópia.
3. **Disco interno** (`~/autocut-premiere`) — onde o backend roda. Só importa se `server/` mudou:
   `git pull ssd master` + `launchctl kickstart -k gui/$(id -u)/com.reconecta.autocut-backend`.
