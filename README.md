# AutoCut — rough cut automático por IA para o Premiere Pro

Plugin (painel UXP) inspirado no AutoEdit: dado um clip de talking-head já na timeline,
gera uma lista de cortes (silêncios, filler words, repetições, bad takes) e monta uma
sequência **"Rough Cut" não-destrutiva** com os trechos bons. Revisão humana antes de aplicar.

## Como funciona (arquitetura)

```
┌──────────────────────┐    HTTP localhost     ┌──────────────────────────────┐
│  Painel UXP (Premiere)│ ────────────────────▶ │  Backend Node local           │
│  - botão Auto-Edit    │                       │  - ffmpeg (extrai áudio)      │
│  - prompt opcional    │  /transcribe          │  - WhisperX/OpenAI (transcreve)│
│  - tela de revisão    │  /analyze             │  - Claude (classifica cortes) │
│  - monta a sequência  │ ◀──────────────────── │  - ffmpeg silencedetect       │
└──────────────────────┘   cuts[] (JSON)        └──────────────────────────────┘
```

- **Por que dois processos?** O UXP não roda ffmpeg/Python nem deve carregar a chave de
  API. O backend faz o trabalho pesado e segura as chaves; o painel só fala HTTP com ele.
- **Por que "Rough Cut" e não cortar in-place?** A API do Premiere **não tem razor/split
  programático** (confirmado na doc da Adobe). Então, em vez de fatiar o clip, montamos
  uma sequência nova só com os trechos mantidos. Bônus: o clip e a sequência originais
  ficam intactos.
- **Decisão UXP (não CEP):** a Adobe declarou o CEP "superseded" pelo UXP a partir do
  Premiere 25.6 e recomenda começar projetos novos em UXP.

## Pré-requisitos

- **Adobe Premiere Pro ≥ 25.6** (UXP GA).
- **Node.js ≥ 20** e **ffmpeg/ffprobe** no PATH.
- Transcrição (escolha um):
  - **WhisperX local** (default) — venv Python com `whisperx` + modelos `large-v3` e o
    align pt-BR `jonatasgrosman/wav2vec2-large-xlsr-53-portuguese`. Defina `WHISPERX_BIN`.
  - **OpenAI** — `TRANSCRIBER=openai` + `OPENAI_API_KEY`.
  - **ElevenLabs Scribe v2** (v2, 21/09/2026) — `TRANSCRIBER=elevenlabs`; a chave vem do Keychain
    (`security add-generic-password -s elevenlabs-api-key -a "$USER" -w`). O corte usa a transcrição
    LITERAL (mantém hesitação e o `--` de fala cortada, que alimenta o detector de falso começo);
    o Exportar SRT pede a LIMPA (número em algarismo, sem hesitação). Comparação medida contra o
    WhisperX: `server/scripts/comparar_motores.py`.
- **Chave Anthropic** (`ANTHROPIC_API_KEY`) para a análise dos cortes.

## Setup

### 1) Backend

```bash
cd server
cp .env.example .env          # preencha as chaves e o caminho do whisperx
npm install
npm start                     # sobe em http://127.0.0.1:7867
```

Variáveis principais (`server/.env`):

| Var | Default | O quê |
|---|---|---|
| `TRANSCRIBER` | `whisperx` | `whisperx` (local), `openai` ou `elevenlabs` (Scribe v2) |
| `WHISPERX_BIN` | venv do vsl-editor | binário do whisperx |
| `WHISPERX_MODEL` | `large-v3` | modelo de ASR |
| `ANTHROPIC_API_KEY` | — | chave do Claude (obrigatória p/ análise) |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | flip p/ `claude-opus-4-8` = mais qualidade |
| `ANTHROPIC_EFFORT` | `medium` | `low`/`medium`/`high`/`max` |
| `OPENAI_API_KEY` | — | só se `TRANSCRIBER=openai` |
| `SILENCE_THRESHOLD_DB` | `-30` | nível (dB) abaixo do qual é silêncio |
| `SILENCE_MIN_SEC` | `0.6` | duração mínima de silêncio p/ cortar |
| `AUTH_TOKEN` | (vazio) | deixe vazio em uso local |

### 2) Painel UXP

```bash
cd panel
npm install
npm run build                 # gera panel/dist/ (manifest + bundle)
```

Carregue em modo dev com o **UXP Developer Tool (UDT)**:
1. Abra o Premiere Pro.
2. No UDT: **Add Plugin** → selecione `panel/dist/manifest.json` (a pasta *buildada*, que tem o `index.js`).
3. **Load** → o painel "AutoCut" aparece em *Window → Extensions* (ou no UDT, **⋯ → Load**).

## Como usar

1. Garanta que o **backend está rodando** (o painel mostra um status verde/vermelho).
2. Na timeline, **selecione o clip** de talking-head.
3. (Opcional) escreva instruções no campo de prompt.
4. Clique **Auto-Edit** → transcreve → analisa → mostra a **tela de revisão**.
5. Marque/desmarque os cortes (cada um tem motivo, intervalo e explicação).
6. **Aplicar** → cria a sequência "Rough Cut - <clip>" com os trechos mantidos.

## Testar o backend sem o Premiere

O backend é testável sozinho via HTTP. Gere um áudio de teste e rode:

```bash
# saúde
curl -s localhost:7867/health

# transcrição (whisperx) de um arquivo qualquer
curl -s -X POST localhost:7867/transcribe \
  -H "Content-Type: application/json" \
  -d '{"audioPath":"/caminho/audio.mp4","language":"pt"}'

# análise: pegue o "transcript" da resposta acima e mande pra /analyze
#   includeSemantic:false  -> só silêncio (não chama o Claude)
curl -s -X POST localhost:7867/analyze \
  -H "Content-Type: application/json" \
  -d '{"audioPath":"/caminho/audio.mp4","includeSemantic":false,
       "transcript":{"words":[],"text":"","language":"pt","durationSec":60,"engine":"whisperx"}}'
```

## Estrutura

```
autocut-premiere/
├── shared/            tipos + computeKeeps (contrato painel↔backend, lógica pura)
├── server/            backend Node: ffmpeg, transcrição, silêncio, Claude
│   └── src/services/{audio,transcription,analysis}/
├── panel/             painel UXP (vanilla TS + DOM)
│   └── src/{premiere,api,state,ui}/
└── docs/              arquitetura + checklist de TODOs da API do Premiere
```

## Estado de verificação

- ✅ **Backend testado ponta a ponta com dado real:** `/transcribe` (WhisperX large-v3 pt-BR),
  `/analyze` com chamada real ao Claude (filler/bad-take) + silêncio acústico + merge.
- ✅ **`computeKeeps` testado:** complemento, padding, snap a frame, offset de origem.
- ✅ **Painel compila (`tsc`) e empacota (`webpack`).**
- ⚠️ **A aplicação dos cortes no Premiere via UXP** foi escrita sobre assinaturas conferidas
  na doc oficial, mas **só dá pra validar rodando no Premiere ≥ 25.6** — ver
  [docs/premiere-api-todos.md](docs/premiere-api-todos.md) (7 pontos; o principal é o
  comportamento do in/out interleaved — há fallback `perSegmentTransaction`).

## Segurança

- A chave de API vive **só** em `server/.env` (gitignored). O painel nunca a vê — só fala
  `http://127.0.0.1:7867`.

## Limitações conhecidas

- Sem razor programático → entregamos uma **sequência nova**, não cortes in-place.
- A classificação da IA é conservadora mas não infalível — por isso a **revisão é humana**.
- Vídeos muito longos podem exigir streaming/chunking na análise (hoje 1 request).

## Distribuir depois (costuras já prontas)

1. Painel fala com o backend por uma `baseUrl` configurável (127.0.0.1 → https://… = 1 config).
2. Chave sempre no servidor (migrar p/ hospedado não muda o modelo de segurança).
3. Header `Authorization` já enviado (vazio local; plugar token quando hospedar).
4. `audioSource.ts` isola "como o áudio chega ao backend" (local hoje; upload no futuro).
```
