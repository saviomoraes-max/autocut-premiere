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
  `--danger`), tirados do handoff. A 980 px sai como o design; `@media` em 880 (o que não cabe
  desce de linha), 720 (margem menor), 520 (linhas de opção empilham) e 440 (painel encaixado,
  mínimo 230 px).
- `panel/src/ui/kit.ts` — as peças: `make()`, `btn()`/`link()` (clicáveis em `<div>`), caixa de
  marcação, chip, stepper, contador de duração, grupo segmentado, rodapé fixo, e as duas animações.
- `panel/src/ui/app.ts` — a lógica e as telas: `renderHome`, `renderProcessar`, `renderRevisar`,
  `renderTexto`, `renderZoom`, `renderSrt`, `renderConfig`, `renderErro`, `renderVazio`,
  `renderNada`, `renderDiag`.
- A paleta é a do handoff (quase monocromática), NÃO a da marca. Se um dia alinhar com a
  identidade RECONECTA, a única fonte dos tokens é `design-system/core/tokens.json` no
  repositório `saviomoraes-max/carrosseis` — referencie de lá, não invente cor.
- Ficaram de fora de propósito (o handoff marca como dependentes de backend que não existe):
  play do trecho, prévia ao vivo da transcrição, respiro por corte.

## Regras do UXP (o painel NÃO roda num Chromium)

Cada uma destas já quebrou o painel antes — estão comentadas no código onde aconteceram.

**Medido dentro do Premiere 26.5 (UXP 9.3) em 21/09/2026** — a primeira versão do redesign passou
em todos os testes no Chromium e saiu desmontada no Premiere por causa destas:

- **`gap` não existe** (nem em linha, nem com quebra). Espaço entre itens é margem: `> * + *` em
  linha fixa; em linha que quebra, margem nos filhos + margem negativa no pai (ver `.prompt-chips`).
- **Filho de flex em coluna encolhe abaixo do conteúdo** (não há `min-height: auto`): 100 px viram
  25 px e os blocos se sobrepõem. O corpo da tela é `display: block`; coluna flex só onde a altura
  não é limitada.
- **`<button>` é widget nativo:** ignora `background-color`, impõe largura/altura mínimas e 6 px de
  margem, e com raio grande vira elipse. Nada de `<button>` — use `btn()`/`link()` do `kit.ts`
  (`<div role="button">`, com `disabled` imitado).
- **Pílula = altura fixa + raio de exatamente metade da altura** (contando a borda). Nada de `999px`.
- **`letter-spacing` negativo é inválido** (documentado pela Adobe: as letras encavalam).
- **`text-transform`, `transition` e alinhamento `baseline` não funcionam** (known issues). Rótulo
  em maiúsculas vem escrito em maiúsculas.
- **Mono:** `ui-monospace` e "SF Mono" não existem no UXP; o mono cai no Menlo.
- **`querySelector`/`querySelectorAll` com seletor de descendente falham às vezes** (o CSS aplica
  certo, a busca não). No código, guarde referências; nos testes, `getElementsByClassName`.
- **`element.click()` não dispara os ouvintes**; `dispatchEvent(new Event("click"))` dispara.
- **`fetch` com `signal: undefined` falha** como se o backend estivesse fora — mande sempre um signal.
- O `index.html` também carrega o `styles.css` por `<link>` (além do `<style>` injetado).

Regras antigas, que continuam valendo:

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

## Ver o painel DENTRO do Premiere (a verificação que vale)

`panel/dev/uxp.mjs` fala com o UXP Developer Tool (porta 14001) e roda JS no painel de verdade.
Precisa do UXP Developer Tool aberto com o Premiere conectado.

```bash
npm --prefix panel run build
node panel/dev/uxp.mjs load                    # recarrega o painel no Premiere
node panel/dev/uxp.mjs tela revisar            # abre uma tela (home, processar, revisar, texto,
                                               #   zoom, srt, config, erro, vazio) — revisar/texto/zoom
                                               #   usam o bruto de teste do cache, sem gastar API
node panel/dev/uxp.mjs medir 530               # acusa SOBREPÕE / ESTOURA / VAZA naquela largura
node panel/dev/uxp.mjs medir 980 arvore        # idem + posição e tamanho de cada elemento
node panel/dev/uxp.mjs evalfile panel/dev/cliques.js   # 14 cliques conferidos dentro do UXP
```

A largura do `medir` é simulada (as `@media` são reescritas e a tela ganha largura fixa); o painel
real não muda. Rode todas as telas em 230, 300, 440, 530, 720, 880 e 980 antes de dizer que o
layout está pronto. Não há captura de tela pelo depurador do UXP: o que o `medir` não pega (cor,
fonte, o `<textarea>` nativo) só se vê no Premiere.

## Ver o painel fora do Premiere

`panel/dev/painel.html` carrega o painel compilado num navegador com o Premiere SIMULADO (uma
sequência com um clipe) e o backend de verdade. Serve de prévia visual e de teste de
comportamento — **não** prova o layout do UXP (ver as regras acima). Dois roteiros com Playwright:

```bash
npm --prefix panel run build
python3 panel/dev/fotografar.py <bruto.mp4> <duracao_s> [porta]   # fotos em panel/dev/fotos/, 980 e 300 px
python3 panel/dev/interacoes.py <bruto.mp4> <duracao_s> [porta]   # 18 conferências de comportamento
```

É Chromium, não UXP. A palavra final é o `uxp.mjs medir` e o olho no Premiere.

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
