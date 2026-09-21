# Estado do AutoCut — 21/09/2026

Ponto de retomada. Leia isto antes de continuar; o `CLAUDE.md` explica o código, este arquivo
explica onde paramos.

## Onde está cada coisa

| | Situação |
|---|---|
| Código | `master` = `6b85a15`, idêntico no GitHub (`saviomoraes-max/autocut-premiere`, privado), no SSD e no disco interno |
| Backend em produção | `http://localhost:7867`, LaunchAgent, rodando `TRANSCRIBER=elevenlabs` (Scribe v2), análise `local`, silêncio −36 dB |
| Painel que o Premiere carrega | cópia do SSD, `panel/dist/` — já compilado com o redesign |
| Tags | `v1-whisperx` (WhisperX, antes de hoje) · `v2-elevenlabs` (Scribe + falso começo, painel antigo) · `v2.1-painel-quieto` (redesign) |
| Snapshot da v1 | `SSD kenipe/agentes/videos reconecta/autocut-snapshots/v1-whisperx-2026-09-21/` (bundle + o que fica fora do git; `LEIA-ME.md`) |
| Comparação WhisperX × Scribe | `autocut-snapshots/comparacao-motores-2026-09-21/LEIA-ME.md` |
| Backup do `.env` antes da troca de motor | `server/.env.bak-v1-20260921` nas duas cópias (ignorado pelo git — tem chaves) |

Voltar pro WhisperX: `TRANSCRIBER=whisperx` no `server/.env` do disco interno + restart do LaunchAgent.
Voltar pro painel antigo: `git checkout v2-elevenlabs` na cópia do SSD + `npm --prefix panel run build`.

## O que foi feito hoje (21/09)

1. **Snapshot da v1** (WhisperX) com tag, bundle e checksums; restauração testada.
2. **v2: ElevenLabs Scribe v2 como terceiro motor.** Literal (`no_verbatim=false`) pra análise de corte;
   limpo (`no_verbatim=true`) pro Exportar SRT. Chave lida do Keychain `elevenlabs-api-key`.
3. **Detector de falso começo** (`falsoComecoDetect.ts`), portado do Bisturi: marca `--` do Scribe +
   frase recomeçada logo depois.
4. **Correções de dinheiro na legenda** (reels: "62 reais mil" → "62 mil reais"; cinema: "R$1,5 milhão"
   e "R$ 40 mil reais"). Regressão: 119 de 120 SRTs idênticos; o único diferente é o defeito corrigido.
5. **Repositório no GitHub** + `CLAUDE.md`.
6. **Redesign do painel** "1a Quieto" a partir do handoff (`Cyberpunk/downloads/plugins/design_handoff_autocut_redesign 2/`).
   `/health` passou a informar análise e limiar. Banco de testes em `panel/dev/`.
7. **O redesign saiu desmontado no Premiere** (foto do Sávio: blocos sobrepostos, botões em elipse,
   nada responsivo) — tinha sido conferido só no Chromium. Consertado medindo DENTRO do Premiere
   com `panel/dev/uxp.mjs` (fala com o UXP Developer Tool): `gap` não existe no UXP, coluna flex
   espreme os filhos, `<button>` é nativo, pílula com raio 999px vira elipse. CSS reescrito sem
   isso; botões viraram `<div>`. Conferido no Premiere: 9 telas × 7 larguras (230–980) sem
   sobreposição/estouro, 14 cliques ok; no Chromium 18/18. Regras novas no `CLAUDE.md`.
8. **Conferido por FOTO do Premiere** (Gravação de Tela liberada pro VS Code): as 9 telas saem
   limpas. Consertado o que só a foto mostrou: o UXP não desenha `line-through` (riscado agora é
   U+0336 no texto), borda dupla do `<textarea>` nativo (a caixa corta), campos da Config nativos.

## Decisões do Sávio (não reverter sem perguntar)

- Dinheiro em **algarismo só na legenda Cinema** ("R$ 40.000"); no Reels continua por extenso.
- ElevenLabs é o **motor principal** (decisão de 21/09, à tarde — substitui "terceiro motor"):
  agora é o padrão do `config.ts`, não só do `.env`. O WhisperX continua a uma linha de distância.
- `keyterms` **desligado** — agora com medição: mudou o texto e APAGOU uma fala cortada ("dele--"),
  que é justamente o sinal de falso começo. Não é mais "até testar": é ruim pro corte.
- Texto da legenda minúsculo e sem pontuação nos dois estilos (decisão de 28/08).

## Pendente com o Sávio (teste no Premiere)

1. **Redesign:** visual já conferido por foto (21/09). Falta USAR: rodar
   Auto-Edit, conferir as abas da revisão, criar as sequências, ver a confirmação na home,
   testar "Copiar detalhe técnico" na tela de erro. O painel foi recarregado por `uxp.mjs load`;
   se não aparecer, Janela → Extensões (UXP) → AutoCut, ou Load no UXP Developer Tool.
2. **v2 (ElevenLabs):** ouvir os cortes de falso começo (conferidos só pelo texto) e exportar um SRT
   Cinema pra ver algarismo e ausência de `--`.

## Pendente de desenvolvimento (medido, não resolvido)

- **Marcador falso de alta confiança** nos dois motores: "600 reais em anúncio. Seis consultas" →
  "Anúncio seis"; "Mais um curso" → "Mais 1"; "Ou um monte" → "Ou 1". Consequência vista no redesign:
  o retake aos 101 s descartaria 00:22→01:43 porque o bloco começa no marcador falso. **Próximo
  conserto mais valioso** (`markerDetect.ts` / `codeSlateDetect.ts`).
- ~~Retake com as tentativas a menos de 4 s~~ e ~~repetição imediata de frase~~: **resolvidos**
  em 21/09 pelo `retakeSpanDetect.ts` (ver abaixo).
- **Trecho refeito longo (> 20 s)** entra desmarcado de propósito: em bruto de matriz (um corpo,
  vários ganchos) um trecho parecido pode ser outra PEÇA. Falta o Sávio ouvir alguns pra dizer se
  o teto de 20 s está no lugar certo.
- Handoff, itens que dependem de backend novo: play do trecho, prévia ao vivo, progresso em %,
  respiro por corte, desfazer depois de criar a sequência.

## Detecção de retake (refeita em 21/09, à tarde)

`server/src/services/analysis/retakeSpanDetect.ts` — acha o RECOMEÇO (repetição de sequência de
palavras) e corta a tentativa anterior. As três formas reais, tiradas das 60 transcrições em cache:
recado pro editor no meio ("Mano, tá muito ruim isso, peraí"), refação sem aviso ("tu tá certa" →
"você tá certa") e repetição colada ("Curso te devolve certificado." duas vezes).

- **Portão de semelhança** (Jaccard de bigramas do trecho inteiro × o que vem no lugar, mínimo
  0,35): sem ele o detector cortava 45 s de peça boa num bruto de matriz. Medido.
- **`Cut.review`** (novo campo): corte longo/ambíguo entra DESMARCADO no painel.
- **Medição no acervo:** 149 cortes marcados (11,6 min) + 26 pra decidir (5,1 min) em 60
  transcrições. Banco de teste: `npx tsx server/scripts/testar_retakes.ts [prefixo]`.
- **O que o ElevenLabs oferece e NÃO ajudou** (medido no bruto de teste, `server/scripts/scribe_opcoes.mjs`,
  respostas cruas em `autocut-snapshots/scribe-opcoes-2026-09-21/`): diarização (1 falante só),
  eventos de áudio (zero), `seed`+`temperature` (não dá determinismo: 1102 vs 1103 palavras),
  `keyterms` (mudou o texto e apagou um "--"), `logprob` (quase tudo em 0; as 4 palavras abaixo de
  −0,5 eram palavras normais). O que ajuda é o **modo literal**, que preserva o "--" e o recado
  pro editor — e é ele que alimenta o detector.

## Fatos medidos que não estão óbvios no código

- Scribe literal escreve número **por extenso** (0 algarismos num bruto de 5 min) → por isso o SRT usa o modo limpo.
- Scribe **não é determinístico** (1101 × 1103 palavras no mesmo áudio).
- Latência do Scribe **varia muito**: 7,2 s de manhã e 182,4 s à tarde, mesmo áudio de 5min36s. WhisperX: 276,5 s.
- Custo de API da sessão ≈ US$ 0,12.
- CSS do UXP: sem grid, sem `:not`, sem `@keyframes`/`transform`, sem `box-sizing`; `@media` ok;
  `system-ui` antes de `-apple-system` (detalhes no `CLAUDE.md`).

## Bruto de teste usado

`/Volumes/Cyberpunk/vídeos/anúncios perpétuo/setembro/tela dividida/2E37D47E-A5AC-4571-8CAB-599EC20981FF.MP4`
(5min36s, 30 fps). Intacto (tamanho, data e inode conferidos). Já está no cache de transcrição —
rodar de novo não gasta API. O disco Cyberpunk desmonta sozinho: `caffeinate -m -i -s` durante o uso.
