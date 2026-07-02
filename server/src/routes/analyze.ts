// POST /analyze
// Recebe a transcrição (de /transcribe) + referência de áudio e devolve a lista
// de cortes propostos: silêncios (acústico) + filler/repetição/bad-take (Claude).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { log } from "../logger";
import { resolveAudio } from "../services/audio/audioSource";
import { detectSilences } from "../services/analysis/silenceDetect";
import { analyzeSemanticCuts } from "../services/analysis/claudeClient";
import { analyzeSemanticCutsOllama } from "../services/analysis/ollamaClient";
import { detectFillerCuts } from "../services/analysis/fillerDetect";
import { detectMarkers } from "../services/analysis/markerDetect";
import { detectRetakeSignals } from "../services/analysis/retakeDetect";
import { detectPauseBoundaries } from "../services/analysis/pauseBoundaryDetect";
import { detectCodeSlates } from "../services/analysis/codeSlateDetect";
import { detectCommandCuts } from "../services/analysis/commandDetect";
import { detectRepeatedTakeCuts } from "../services/analysis/repeatedTakeDetect";
import { detectZoomPoints } from "../services/analysis/zoomDetect";
import { demoteMarkersAfterRetake } from "../../../shared/blocks";
import { config } from "../config";
import { writeFileSync } from "node:fs";
import { mergeCuts } from "../services/analysis/mergeCuts";
import { clampCutsToWordGaps } from "../services/analysis/wordClamp";
import type { Cut, CutReason, Marker, RetakeSignal, TranscriptResult, ZoomPoint } from "../../../shared/types";

const wordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  score: z.number().optional(),
});

const transcriptSchema = z.object({
  words: z.array(wordSchema),
  text: z.string(),
  language: z.string(),
  durationSec: z.number().nonnegative(),
  engine: z.enum(["whisperx", "openai"]),
});

const clipSchema = z.object({
  mediaPath: z.string().min(1),
  inSec: z.number().nonnegative(),
  outSec: z.number().positive(),
  fps: z.number().positive(),
});

const bodySchema = z
  .object({
    transcript: transcriptSchema,
    // Vários clips achatados num stream contínuo (modo seleção/sequência).
    segments: z.array(clipSchema).min(1).optional(),
    clip: clipSchema.optional(),
    audioPath: z.string().min(1).optional(),
    inSec: z.number().nonnegative().optional(),
    outSec: z.number().positive().optional(),
    userPrompt: z.string().optional(),
    // Quando false, pula o Claude e devolve só cortes de silêncio (modo "burro").
    includeSemantic: z.boolean().optional().default(true),
    silence: z
      .object({
        thresholdDb: z.number().optional(),
        minSilenceSec: z.number().positive().optional(),
      })
      .optional(),
  })
  .refine((b) => Boolean(b.segments?.length || b.clip || b.audioPath), {
    message: "Informe `segments`, `clip` ou `audioPath` (para a detecção de silêncio).",
  });

export interface AnalyzeResponse {
  cuts: Cut[];
  sourceOffsetSec: number;
  stats: {
    porMotivo: Record<CutReason, number>;
    total: number;
    duracaoRemovidaSec: number;
    duracaoTotalSec: number;
  };
  markers: Marker[];
  retakeSignals: RetakeSignal[];
  zoomPoints: ZoomPoint[];
}

export async function analyzeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/analyze", async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const body = parsed.data;
    const transcript = body.transcript as TranscriptResult;
    const durationSec = transcript.durationSec;

    // CALIBRAÇÃO (temporário): salva a última transcrição real pra eu afinar a detecção
    // de marcadores (anúncio/corpo/lead) contra a fala do apresentador, sem achismo.
    try {
      writeFileSync(
        "/tmp/autocut-last-transcript.json",
        JSON.stringify({ words: transcript.words, text: transcript.text, durationSec }),
      );
      log.info(`Transcrição salva p/ calibração: ${transcript.words.length} palavras.`);
    } catch {
      /* dump é best-effort */
    }

    const audio = await resolveAudio({
      segments: body.segments,
      clip: body.clip,
      audioPath: body.audioPath,
      inSec: body.inSec,
      outSec: body.outSec,
    });

    try {
      // Silêncio (acústico) e semântico (Claude) são independentes -> em paralelo.
      const tarefas: Array<Promise<Cut[]>> = [
        detectSilences(audio.wavPath, durationSec, body.silence ?? {}),
      ];
      if (body.includeSemantic) {
        if (config.analyzer === "local") {
          // Modo LOCAL grátis: filler/gagueira por CÓDIGO (o silêncio já roda à parte).
          // Sem LLM, sem custo, timestamp exato. Retake fica pro humano (com a trava).
          tarefas.push(Promise.resolve(detectFillerCuts(transcript.words)));
        } else {
          // LLM: Ollama local ou Anthropic (API paga).
          const analisar =
            config.analyzer === "anthropic" ? analyzeSemanticCuts : analyzeSemanticCutsOllama;
          tarefas.push(analisar(transcript, { userPrompt: body.userPrompt }));
        }
      }
      const [silenciosRaw, semanticos = []] = await Promise.all(tarefas);

      // TRAVA DE SEGURANÇA: o silêncio NUNCA pode tocar numa palavra transcrita.
      // (Os cortes semânticos removem fala de propósito, então NÃO são travados.)
      const silencios = clampCutsToWordGaps(silenciosRaw, transcript.words, { guardSec: 0.05 });

      // Recado pro editor ("vou gravar de novo", "peraí") + takes repetidos (mesma parte
      // regravada sem anunciar): removem fala DE PROPÓSITO, então NÃO passam pela trava de
      // silêncio — entram no merge junto com os semânticos. Determinístico, custo zero.
      const comandos = detectCommandCuts(transcript.words);
      const repetidos = detectRepeatedTakeCuts(transcript.words);
      const cuts = mergeCuts([...silencios, ...semanticos, ...comandos, ...repetidos], durationSec);

      // SEGMENTAÇÃO: marcadores falados (fronteiras de bloco) + sinais de retake do chefe.
      // Determinístico, das próprias palavras — o painel mostra pro humano confirmar.
      const retakeSignals = detectRetakeSignals(transcript.words);
      // Marcadores falados (vocabulário fixo) + CLAQUETES-NÚMERO (palavra-código + N, ex.: "RUC 1",
      // "Cook 3", "Hulk 7" — quando o chefe grava N versões de um mesmo início) + fronteiras por
      // PAUSA longa. Dedup por proximidade (mesmo instante, palavras diferentes) mantendo a de
      // maior confiança.
      const marcadoresFalados = detectMarkers(transcript.words);
      const codeSlates = detectCodeSlates(transcript.words);
      const pausas = detectPauseBoundaries(transcript.words);
      const brutos = [...marcadoresFalados, ...codeSlates, ...pausas].sort((a, b) => a.startSec - b.startSec);
      const dedup: Marker[] = [];
      for (const m of brutos) {
        const perto = dedup[dedup.length - 1];
        if (perto && Math.abs(perto.startSec - m.startSec) < 0.5) {
          // mesmo ponto: fica com a de confiança ALTA (marcador falado > claquete > pausa)
          if (m.confidence === "alta" && perto.confidence !== "alta") dedup[dedup.length - 1] = m;
          continue;
        }
        dedup.push(m);
      }
      // Rebaixa re-slates (marcador logo após um retake) — o corte de retake já cobre o trecho.
      const markers = demoteMarkersAfterRetake(dedup, retakeSignals);
      // Auto-Zoom: pontos de interesse pra punch-in (mesma transcrição, custo zero).
      const zoomPoints: ZoomPoint[] = detectZoomPoints(transcript.words);
      log.info(
        `Marcadores: ${markers.length} (${markers.filter((m) => m.confidence === "alta").length} alta) · retakes: ${retakeSignals.length} (${retakeSignals.filter((r) => r.confidence === "alta").length} alta).`,
      );

      const porMotivo: Record<CutReason, number> = {
        silencio: 0,
        filler: 0,
        repeticao: 0,
        bad_take: 0,
        comando: 0,
      };
      let duracaoRemovidaSec = 0;
      for (const c of cuts) {
        porMotivo[c.reason]++;
        duracaoRemovidaSec += c.end - c.start;
      }

      const res: AnalyzeResponse = {
        cuts,
        sourceOffsetSec: audio.sourceOffsetSec,
        stats: {
          porMotivo,
          total: cuts.length,
          duracaoRemovidaSec,
          duracaoTotalSec: durationSec,
        },
        markers,
        retakeSignals,
        zoomPoints,
      };
      log.info(
        `Cortes: ${cuts.length} (${porMotivo.silencio} silêncio, ${porMotivo.filler} filler, ${porMotivo.repeticao} repetição, ${porMotivo.bad_take} bad-take, ${porMotivo.comando} comando), -${duracaoRemovidaSec.toFixed(1)}s.`,
      );
      return res;
    } catch (err) {
      log.error("Falha na análise:", err instanceof Error ? err.message : err);
      return reply
        .status(500)
        .send({ error: err instanceof Error ? err.message : "erro desconhecido" });
    } finally {
      await audio.cleanup();
    }
  });
}
