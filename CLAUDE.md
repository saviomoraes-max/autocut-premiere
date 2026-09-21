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

- `panel/src/styles.css` — todo o visual. As variáveis ficam no topo (`--bg`, `--accent`…),
  incluindo uma cor por tipo de corte (`--silencio`, `--filler`, `--repeticao`, `--bad_take`,
  `--comando`) que aparece nos selos da lista de cortes.
- `panel/src/ui/app.ts` — a montagem das telas. Cada tela é um `render*` (`renderIdle`,
  `renderReview`, `renderTextEditor`, `renderBusy`, `renderDone`, `renderError`). O DOM é
  montado pelo helper `make(tag, attrs, filhos)`.
- A paleta atual NÃO é a da marca. Se o redesign for alinhar com a identidade RECONECTA, a única
  fonte dos tokens é `design-system/core/tokens.json` no repositório
  `saviomoraes-max/carrosseis` — referencie de lá, não invente cor.

## Regras do UXP (o painel roda num Chromium antigo e restrito)

Cada uma destas já quebrou o painel antes — estão comentadas no código onde aconteceram.

- **Sem `innerHTML`.** Monte com `make()`.
- **`style` via atributo:** `e.setAttribute("style", "...")`. O UXP não aceita `e.style = "..."`.
- **Nunca o atalho `inset`.** Use `top`, `right`, `bottom` e `left` explícitos — com `inset` o
  elemento fica sem altura e nada rola.
- **Evite `position: sticky` e `position: fixed` para layout.** No UXP eles não reservam espaço e
  o conteúdo passa por baixo (o menu cobria o texto no editor). O padrão que funciona é o shell
  em flex do `.te-shell`: cabeçalho estático, meio com `flex: 1 1 auto; min-height: 0;
  overflow-y: auto`, barra de ações estática no fim.
- **Rede só por nome:** `localhost`, nunca `127.0.0.1` (o UXP bloqueia IP).
- **O CSS vai embutido no JS** (`panel/src/index.ts` injeta o `styles.css` como `<style>`).
  Mudou o CSS → rebuild. O console do UXP fica escondido; erro de montagem aparece no próprio
  painel.

## Build e teste do painel

```bash
npm --prefix panel ci            # primeira vez
npm --prefix panel run build     # gera panel/dist/
(cd panel && npx tsc --noEmit)   # typecheck
```

No Premiere: UXP Developer Tool → linha do AutoCut → **Reload**. Mudança só de visual não
precisa mexer no backend.

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
