// Lê os PARES (vídeo V1 + áudio A1) a processar e monta os ClipRefs do backend.
//
// O áudio é lido da TRILHA DE ÁUDIO A1 — é ele que se transcreve, porque pode ser um
// arquivo separado, vinculado ao vídeo (não o áudio embutido do clipe de vídeo). Cada
// clipe de áudio é PAREADO com o clipe de vídeo (V1) que ocupa o mesmo span de timeline.
//
// Regra de escopo (Premiere-native): se há clipes SELECIONADOS, processa só os pares
// cujo áudio cai dentro da seleção; senão, processa a sequência inteira (toda a A1).
//
// API do Premiere UXP é async — tudo aqui usa await (assinaturas oficiais @adobe/premierepro).
import type {
  AudioClipTrackItem,
  ClipProjectItem,
  FolderItem,
  ProjectItem,
  Sequence,
  VideoClipTrackItem,
} from "@adobe/premierepro";
import type { ClipRef } from "../../../shared/types";
import { ppro } from "./ppro";

// 1 segundo = 254.016.000.000 ticks (timebase interno do Premiere).
const TICKS_PER_SECOND = 254016000000;

type AnyClipTrackItem = VideoClipTrackItem | AudioClipTrackItem;

/** Uma fonte de mídia (vídeo ou áudio): ClipRef serializável + handles duráveis do bin. */
export interface SourceRef {
  clipRef: ClipRef;
  clip: ClipProjectItem;
  projectItem: ProjectItem;
  /** O track item NA TIMELINE (não o do bin) — necessário pra cadeia de efeitos (Auto-Zoom). */
  trackItem: AnyClipTrackItem;
}

/** Um par linkado da timeline: vídeo (saída V1) + áudio (transcrição e saída A1). */
export interface TimelineSegment {
  audio: SourceRef;
  video: SourceRef;
  /** Span na timeline (s) — usado pra parear e ordenar. */
  timelineStartSec: number;
  timelineEndSec: number;
}

export interface TimelineRead {
  segments: TimelineSegment[];
  source: "selection" | "sequence";
}

/** Item de track com sua posição na timeline (pra parear áudio↔vídeo por overlap). */
interface PlacedItem {
  item: AnyClipTrackItem;
  startSec: number;
  endSec: number;
}

export async function readSegments(): Promise<TimelineRead> {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Nenhum projeto aberto no Premiere.");

  const seq = await project.getActiveSequence();
  if (!seq) throw new Error("Nenhuma sequência ativa. Abra a sequência no Premiere.");

  const timebase = Number(await seq.getTimebase());
  const fps = timebase > 0 ? TICKS_PER_SECOND / timebase : 25;

  // 1. Clipes de ÁUDIO da trilha A1 (índice 0) — fonte da transcrição.
  const audioItems = await readAudioTrackItems(seq, 0);
  if (!audioItems.length) {
    throw new Error(
      "Nenhum clipe na trilha de áudio A1. O AutoCut transcreve o áudio do A1 — coloque o áudio real lá.",
    );
  }

  // 2. Todos os clipes de VÍDEO (todas as tracks de vídeo) — candidatos a parear.
  const videoItems = await readAllVideoTrackItems(seq);

  // 3. Escopo: seleção (se houver) restringe os pares pelo span dos itens selecionados.
  const selection = await seq.getSelection();
  const selected = (await selection.getTrackItems()) as AnyClipTrackItem[];
  let chosenAudio = audioItems;
  let source: "selection" | "sequence" = "sequence";
  if (selected.length > 0) {
    const spans = await placedSpans(selected);
    chosenAudio = audioItems.filter((a) => spans.some((s) => overlap(a.startSec, a.endSec, s.startSec, s.endSec) > 0));
    source = "selection";
    if (!chosenAudio.length) {
      throw new Error("A seleção não cobre nenhum clipe da trilha A1. Selecione os clipes (ou deixe vazio p/ a sequência toda).");
    }
  }

  // 4. Monta os pares áudio↔vídeo (melhor overlap), pulando o que não for clipe de mídia.
  const segments: TimelineSegment[] = [];
  for (const a of chosenAudio) {
    const audio = await buildSourceRef(a.item, fps);
    if (!audio) continue; // não é clipe de mídia (ex.: tom/silêncio gerado)

    const vMatch = bestOverlap(a, videoItems);
    if (!vMatch) continue; // sem vídeo pareado — não dá pra montar vídeo+áudio
    const video = await buildSourceRef(vMatch.item, fps);
    if (!video) continue;

    segments.push({ audio, video, timelineStartSec: a.startSec, timelineEndSec: a.endSec });
  }
  if (!segments.length) {
    throw new Error("Não encontrei pares vídeo+áudio na timeline (cada áudio do A1 precisa de um vídeo alinhado).");
  }

  // 5. Ordena por posição na timeline (o stream achatado segue essa ordem).
  segments.sort((x, y) => x.timelineStartSec - y.timelineStartSec);
  return { segments, source };
}

/**
 * Re-resolve, DIRETO DO BIN DO PROJETO (por caminho de mídia), os ProjectItems dos clipes que
 * vão ser depositados. Os handles capturados da timeline "expiram" no UXP depois de criar uma
 * sequência (createSequenceFromMedia) — daí o "The script object is no longer valid" na fatia0
 * do bloco seguinte. O bin é DURÁVEL e independe da sequência ativa; um handle recém-buscado é
 * sempre válido. Chame ANTES de cada bloco pra ter handles frescos.
 */
export async function resolveClipsByPath(
  paths: ReadonlySet<string>,
  project?: import("@adobe/premierepro").Project,
): Promise<Map<string, { clip: ClipProjectItem; projectItem: ProjectItem }>> {
  const out = new Map<string, { clip: ClipProjectItem; projectItem: ProjectItem }>();
  // IMPORTANTE (PR26): use a MESMA instância de Project que vai rodar a transação — objetos
  // ClipProjectItem obtidos de outra instância viram "no longer valid" ao serem usados.
  const proj = project ?? (await ppro.Project.getActiveProject());
  if (!proj) return out;
  const root = await proj.getRootItem();
  const fila: FolderItem[] = [root];
  while (fila.length) {
    const folder = fila.shift() as FolderItem;
    let items: ProjectItem[];
    try {
      items = await folder.getItems();
    } catch {
      continue; // pasta ilegível — segue
    }
    for (const it of items) {
      const asFolder = ppro.FolderItem.cast(it);
      if (asFolder) {
        fila.push(asFolder); // desce em sub-bins
        continue;
      }
      const clip = ppro.ClipProjectItem.cast(it);
      if (!clip) continue; // sequência/legenda/etc. — não é clipe de mídia
      let p = "";
      try {
        p = (await clip.getMediaFilePath()) ?? "";
      } catch {
        continue;
      }
      if (p && paths.has(p) && !out.has(p)) out.set(p, { clip, projectItem: it });
    }
    if (out.size >= paths.size) break; // achou todos os caminhos pedidos
  }
  return out;
}

/** Um clip de áudio da A1 (SEM exigir par de vídeo) — base do SRT, que só legenda o áudio. */
export interface AudioSegment {
  audio: SourceRef;
  timelineStartSec: number;
  timelineEndSec: number;
}

/**
 * Lê SÓ os clipes de áudio da A1 (TODOS, sem exigir vídeo pareado). O Auto-Edit precisa do par
 * vídeo+áudio pra montar o rough cut; o SRT NÃO — ele só legenda o áudio. Exigir vídeo fazia
 * clips de áudio legítimos (sem par de vídeo na mesma posição) SUMIREM do SRT, abrindo buraco
 * de legenda no meio. Respeita a seleção, igual ao readSegments.
 */
export async function readAudioSegments(): Promise<{
  segments: AudioSegment[];
  source: "selection" | "sequence";
  /** Quantos clipes de áudio a A1 tem no total (antes de filtrar não-mídia) — p/ diagnóstico. */
  totalAudioClips: number;
}> {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Nenhum projeto aberto no Premiere.");
  const seq = await project.getActiveSequence();
  if (!seq) throw new Error("Nenhuma sequência ativa. Abra a sequência no Premiere.");

  const timebase = Number(await seq.getTimebase());
  const fps = timebase > 0 ? TICKS_PER_SECOND / timebase : 25;

  const audioItems = await readAudioTrackItems(seq, 0);
  if (!audioItems.length) {
    throw new Error("Nenhum clipe na trilha de áudio A1. O AutoCut transcreve o áudio do A1.");
  }

  const selection = await seq.getSelection();
  const selected = (await selection.getTrackItems()) as AnyClipTrackItem[];
  let chosen = audioItems;
  let source: "selection" | "sequence" = "sequence";
  if (selected.length > 0) {
    const spans = await placedSpans(selected);
    chosen = audioItems.filter((a) => spans.some((s) => overlap(a.startSec, a.endSec, s.startSec, s.endSec) > 0));
    source = "selection";
    if (!chosen.length) {
      throw new Error("A seleção não cobre nenhum clipe da A1. Selecione os clipes (ou deixe vazio).");
    }
  }

  const segments: AudioSegment[] = [];
  let houveNest = false;
  for (const a of chosen) {
    const audio = await buildSourceRef(a.item, fps);
    if (audio) {
      segments.push({ audio, timelineStartSec: a.startSec, timelineEndSec: a.endSec });
      continue;
    }
    // Não é mídia direta → pode ser SEQUÊNCIA ANINHADA: entra nela e lê o A1 dela.
    const nested = await expandNestedAudio(a.item, fps);
    if (nested.length) {
      houveNest = true;
      for (const n of nested) segments.push(n);
    }
  }
  segments.sort((x, y) => x.timelineStartSec - y.timelineStartSec);
  if (!segments.length) {
    throw new Error(
      houveNest
        ? "A sequência aninhada não tem clipe de áudio com mídia na A1 dela."
        : "Não encontrei clipes de áudio com mídia na A1 (nem direto, nem em sequência aninhada).",
    );
  }
  segments.sort((x, y) => x.timelineStartSec - y.timelineStartSec);
  return { segments, source, totalAudioClips: chosen.length };
}

/** Lê os clipes (CLIP, sem gaps) de uma trilha de áudio, com seus spans de timeline. */
async function readAudioTrackItems(seq: Sequence, trackIndex: number): Promise<PlacedItem[]> {
  const count = await seq.getAudioTrackCount();
  if (trackIndex >= count) return [];
  const track = await seq.getAudioTrack(trackIndex);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  return placedSpans(items as AnyClipTrackItem[]);
}

/** Lê os clipes de TODAS as tracks de vídeo, com seus spans de timeline. */
async function readAllVideoTrackItems(seq: Sequence): Promise<PlacedItem[]> {
  const count = await seq.getVideoTrackCount();
  const all: AnyClipTrackItem[] = [];
  for (let i = 0; i < count; i++) {
    const track = await seq.getVideoTrack(i);
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const it of items) all.push(it as AnyClipTrackItem);
  }
  return placedSpans(all);
}

/** Resolve o span (start/end na timeline) de cada track item. */
async function placedSpans(items: AnyClipTrackItem[]): Promise<PlacedItem[]> {
  const out: PlacedItem[] = [];
  for (const item of items) {
    const startSec = (await item.getStartTime()).seconds;
    const endSec = (await item.getEndTime()).seconds;
    out.push({ item, startSec, endSec });
  }
  return out;
}

/** Sobreposição (s) entre dois spans de timeline. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Clipe de vídeo com maior sobreposição com o span do áudio. */
function bestOverlap(audio: PlacedItem, videos: PlacedItem[]): PlacedItem | null {
  let best: PlacedItem | null = null;
  let bestOv = 0;
  for (const v of videos) {
    const ov = overlap(audio.startSec, audio.endSec, v.startSec, v.endSec);
    if (ov > bestOv) {
      bestOv = ov;
      best = v;
    }
  }
  return best;
}

/** Um clipe de áudio PRESENTE na timeline ativa: mídia de origem + in/out (s) na origem. */
export interface TimelineAudioSpan {
  /** Caminho da mídia de origem ("" quando `resolvePaths` é false — só pra assinatura barata). */
  mediaPath: string;
  inSec: number;
  outSec: number;
}

/**
 * Lê os clipes da trilha A1 da sequência ATIVA com o in/out na mídia de origem.
 * Base do "espelhar a timeline no texto": uma palavra cujo tempo de origem cai dentro
 * de um destes spans está PRESENTE na timeline; o que sobra foi removido pelo editor.
 *
 * `resolvePaths=false` pula o getProjectItem/getMediaFilePath (caro) — serve só pra
 * montar a ASSINATURA (in/out) e detectar se a timeline mudou, sem custo de resolver mídia.
 */
export async function readTimelineAudioSpans(resolvePaths: boolean): Promise<TimelineAudioSpan[]> {
  const project = await ppro.Project.getActiveProject();
  if (!project) return [];
  const seq = await project.getActiveSequence();
  if (!seq) return [];
  const count = await seq.getAudioTrackCount();
  if (count <= 0) return [];
  const track = await seq.getAudioTrack(0);
  const items = (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) as AnyClipTrackItem[];

  const out: TimelineAudioSpan[] = [];
  for (const it of items) {
    const inSec = (await it.getInPoint()).seconds;
    const outSec = (await it.getOutPoint()).seconds;
    if (!(outSec > inSec)) continue;
    let mediaPath = "";
    if (resolvePaths) {
      const projectItem = await it.getProjectItem();
      const clip = ppro.ClipProjectItem.cast(projectItem);
      if (!clip) continue; // tom/silêncio gerado — sem mídia
      mediaPath = (await clip.getMediaFilePath()) ?? "";
      if (!mediaPath) continue;
    }
    out.push({ mediaPath, inSec, outSec });
  }
  return out;
}

/** Se o projectItem for uma SEQUÊNCIA (nest), devolve essa sequência; senão null. */
async function nestedSequenceOf(
  projectItem: ProjectItem,
): Promise<import("@adobe/premierepro").Sequence | null> {
  try {
    const clip = ppro.ClipProjectItem.cast(projectItem);
    if (!clip) return null;
    const seq = await clip.getSequence(); // um item de MÍDIA não devolve sequência utilizável
    if (seq && typeof (seq as unknown as { getAudioTrackCount?: unknown }).getAudioTrackCount === "function") {
      return seq;
    }
  } catch {
    /* não é sequência aninhada */
  }
  return null;
}

/**
 * SEQUÊNCIA ANINHADA na A1: o clipe da A1 é uma sub-sequência, não um arquivo. Entra nela, lê o
 * A1 DELA (clipes de mídia reais) e devolve cada um remapeado pro tempo do PAI. O nest tem uma
 * posição (getStartTime) e uma janela usada (getInPoint/getOutPoint na timeline aninhada); um
 * clipe interno em [a,b] da janela aparece no pai em [parentStart + (a - nestIn), …]. O recorte
 * da mídia (inSec/outSec) acompanha o que a janela do nest apara. Um nível de aninhamento.
 */
async function expandNestedAudio(item: AnyClipTrackItem, fps: number): Promise<AudioSegment[]> {
  const projectItem = await item.getProjectItem();
  const nested = await nestedSequenceOf(projectItem);
  if (!nested) return [];

  const parentStart = (await item.getStartTime()).seconds;
  const nestIn = (await item.getInPoint()).seconds;
  const nestOut = (await item.getOutPoint()).seconds;

  const innerCount = await nested.getAudioTrackCount();
  if (innerCount <= 0) return [];
  const innerItems = await readAudioTrackItems(nested, 0); // A1 da sequência aninhada

  const out: AudioSegment[] = [];
  for (const inner of innerItems) {
    const ref = await buildSourceRef(inner.item, fps);
    if (!ref) continue; // 2+ níveis de aninhamento não tratados nesta versão

    // Interseção do clipe interno com a JANELA usada do nest [nestIn, nestOut].
    const a = Math.max(inner.startSec, nestIn);
    const b = Math.min(inner.endSec, nestOut);
    if (b - a <= 1e-3) continue;

    // Recorta a mídia proporcionalmente ao que a janela do nest aparou (sem retime = 1:1).
    const cutFront = a - inner.startSec;
    const cutBack = inner.endSec - b;
    const clipRef = {
      ...ref.clipRef,
      inSec: ref.clipRef.inSec + cutFront,
      outSec: ref.clipRef.outSec - cutBack,
    };
    out.push({
      audio: { ...ref, clipRef },
      timelineStartSec: parentStart + (a - nestIn),
      timelineEndSec: parentStart + (b - nestIn),
    });
  }
  return out;
}

/** Resolve um track item → SourceRef (mídia + in/out na origem), ou null se não for mídia. */
async function buildSourceRef(item: AnyClipTrackItem, fps: number): Promise<SourceRef | null> {
  const projectItem = await item.getProjectItem();
  const clip = ppro.ClipProjectItem.cast(projectItem);
  if (!clip) return null;

  const mediaPath = await clip.getMediaFilePath();
  if (!mediaPath) return null;

  const inSec = (await item.getInPoint()).seconds;
  const outSec = (await item.getOutPoint()).seconds;
  if (!(outSec > inSec)) return null;

  return { clipRef: { mediaPath, inSec, outSec, fps }, clip, projectItem, trackItem: item };
}
