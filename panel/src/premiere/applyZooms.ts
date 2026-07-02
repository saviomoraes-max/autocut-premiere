// Auto-Zoom (opção B): aplica o efeito TRANSFORMAR direto nos clips da V1 e keyframa a ESCALA
// (100 → até 110 → 100) nos pontos de interesse. NÃO-destrutivo (efeito por cima do clip;
// some ao remover o efeito). Tudo por código, aterrado na API real do @adobe/premierepro:
//   VideoFilterFactory.createComponent(matchName) + getDisplayNames() (descobre "Transformar")
//   trackItem.getComponentChain().createAppendComponentAction(comp)   (adiciona o efeito)
//   component.getParam(i).displayName                                  (acha o param "Escala")
//   param.createSetTimeVaryingAction(true)                            (liga keyframes)
//   param.createKeyframe(valor) + keyframe.position + createAddKeyframeAction
//   keyframe.setTemporalInterpolationMode(BEZIER)                      (ease suave)
//
// Dois valores que SÓ o runtime do Premiere revela vão pro diagnóstico na 1ª aplicação:
//   (1) unidade da escala (100 vs 1.0) — lido de getStartValue() e adaptado;
//   (2) referência de tempo do keyframe — lido de volta (getKeyframeListAsTickTimes).
import type { Component, VideoClipTrackItem } from "@adobe/premierepro";
import { ppro, requireActiveProject, tt } from "./ppro";
import type { TimelineSegment } from "./selection";
import type { ClipZoom } from "../../../shared/zoom";

export interface ZoomApplyOptions {
  /** matchName forçado do Transformar (senão descobre pelo display name). */
  transformMatch?: string;
  onDebug?: (label: string, data: unknown) => Promise<void> | void;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

async function step<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`[${label}] ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Descobre o matchName do efeito "Transformar" pelo display name (fallback: Geometry2). */
async function findTransformMatchName(
  onDebug?: ZoomApplyOptions["onDebug"],
): Promise<string> {
  const factory = (ppro as unknown as { VideoFilterFactory?: typeof ppro.VideoFilterFactory })
    .VideoFilterFactory;
  // PING: prova o estado da API de efeitos (se isto vier vazio, é aqui que quebra).
  await onDebug?.("zoom-factory", {
    temFactory: typeof factory,
    temGetMatch: typeof (factory as { getMatchNames?: unknown })?.getMatchNames,
    temGetNames: typeof (factory as { getDisplayNames?: unknown })?.getDisplayNames,
    temCreate: typeof (factory as { createComponent?: unknown })?.createComponent,
  });

  let matches: string[] = [];
  let names: string[] = [];
  try {
    matches = await ppro.VideoFilterFactory.getMatchNames();
    names = await ppro.VideoFilterFactory.getDisplayNames();
  } catch (e) {
    await onDebug?.("zoom-matchnames-erro", { msg: e instanceof Error ? e.message : String(e) });
  }

  // Dump dos efeitos que parecem Transformar/Escala — pra eu ver o NOME REAL no Premiere PT.
  const candidatos = names
    .map((n, i) => ({ nome: n, match: matches[i] }))
    .filter((x) => /transform|geometry|scale|escala|dimension/i.test(`${x.nome} ${x.match}`));
  await onDebug?.("zoom-efeitos", { total: names.length, candidatos });

  let found = "";
  for (let i = 0; i < names.length; i++) {
    if (/^transform(ar)?$/i.test((names[i] ?? "").trim())) {
      found = matches[i];
      break;
    }
  }
  return found || "AE.ADBE Geometry2";
}

/** Acha o param de ESCALA num componente (por display name), dumpando todos pro diagnóstico. */
async function findScaleParam(
  comp: Component,
  onDebug?: ZoomApplyOptions["onDebug"],
): Promise<{ param: ReturnType<Component["getParam"]>; index: number } | null> {
  const count = comp.getParamCount();
  const dump: Array<{ i: number; name: string }> = [];
  let exact: { param: ReturnType<Component["getParam"]>; index: number } | null = null;
  let fuzzy: { param: ReturnType<Component["getParam"]>; index: number } | null = null;

  for (let i = 0; i < count; i++) {
    const p = comp.getParam(i);
    const name = (p.displayName ?? "").trim();
    dump.push({ i, name });
    if (!exact && /^(scale|escala|dimensionar|dimensão|zoom)$/i.test(name)) exact = { param: p, index: i };
    if (
      !fuzzy &&
      /scale|escala|dimension|dimensão|zoom/i.test(name) &&
      !/width|largura|altura|height|posi/i.test(name)
    ) {
      fuzzy = { param: p, index: i };
    }
  }
  await onDebug?.("zoom-params", { count, params: dump });
  return exact ?? fuzzy;
}

/**
 * Aplica os gestos de zoom (já agrupados por clip) nas trilhas de vídeo. Devolve quantos
 * clips receberam zoom. Cada clip ganha UM Transformar com os keyframes de escala.
 */
/** Diagnóstico coletado durante o apply — devolvido pra UI mostrar (o canal /debug pode falhar). */
export interface ZoomDiagEvent {
  label: string;
  data: unknown;
}

export async function applyZooms(
  clipZooms: ClipZoom[],
  segments: TimelineSegment[],
  opts: ZoomApplyOptions = {},
): Promise<{ applied: number; diag: ZoomDiagEvent[] }> {
  // COLETA o diagnóstico num array (e também tenta o canal /debug). A UI mostra isso na tela.
  const diag: ZoomDiagEvent[] = [];
  const report = (label: string, data: unknown): void => {
    diag.push({ label, data });
    void opts.onDebug?.(label, data);
  };

  if (!clipZooms.length) throw new Error("Nenhum gesto de zoom para aplicar.");
  const project = await step("getActiveProject", () => requireActiveProject());
  // PING inicial: prova que chegou no apply e quantos clips.
  report("zoom-start", { clips: clipZooms.length, segs: segments.length });

  const matchName = opts.transformMatch ?? (await findTransformMatchName(report));
  report("zoom-match-escolhido", { matchName });

  let applied = 0;
  for (const cz of clipZooms) {
    const seg = segments[cz.segmentIndex];
    const rotulo = cz.labels.join(", ");
    if (!seg) {
      report("zoom-sem-seg", { seg: cz.segmentIndex });
      continue;
    }

    // CADA clip num try/catch: se um falhar, REPORTA o erro e segue (não derruba os outros).
    try {
      const trackItem = seg.video.trackItem as VideoClipTrackItem;

      // a) cadeia de efeitos do clip + cria e anexa o Transformar.
      const chain = await trackItem.getComponentChain();
      const comp = await ppro.VideoFilterFactory.createComponent(matchName);
      await project.executeTransaction((ca) => {
        ca.addAction(chain.createAppendComponentAction(comp));
      }, "AutoZoom: adicionar Transformar");
      const liveComp = chain.getComponentAtIndex(chain.getComponentCount() - 1) as Component;
      report("zoom-anexado", { seg: cz.segmentIndex, componentes: chain.getComponentCount() });

      // b) acha o param Escala.
      const scale = await findScaleParam(liveComp, report);
      if (!scale) {
        report("zoom-sem-escala", { seg: cz.segmentIndex, rotulo });
        continue;
      }
      const param = scale.param;

      // c) lê a base (pra adaptar a UNIDADE: 100 = percentual; ~1 = normalizado).
      let base = 100;
      try {
        const sv = (await param.getStartValue()) as { value?: { value?: number } };
        const v = sv?.value?.value;
        if (typeof v === "number" && v > 0) base = v;
      } catch {
        /* getStartValue pode falhar antes do 1º keyframe — fica em 100 */
      }
      const unit = base < 5 ? 0.01 : 1; // base ~1 => escala normalizada => 110% vira 1.1
      report("zoom-base", { seg: cz.segmentIndex, paramIndex: scale.index, base, unit });

      // d) liga a animação por keyframe.
      await project.executeTransaction((ca) => {
        ca.addAction(param.createSetTimeVaryingAction(true));
      }, "AutoZoom: ligar keyframes");

      // e) deposita os keyframes (posição relativa ao começo do clip; valor adaptado à unidade).
      for (const k of cz.keys) {
        const valor = k.scale * unit;
        const kf = param.createKeyframe(valor);
        kf.position = tt(Math.max(0, k.relSec));
        if (k.ease === "bezier") {
          try {
            await kf.setTemporalInterpolationMode(ppro.Keyframe.INTERPOLATION_MODE_BEZIER);
          } catch {
            /* se o modo bézier falhar, fica linear (não quebra o gesto) */
          }
        }
        await project.executeTransaction((ca) => {
          ca.addAction(param.createAddKeyframeAction(kf));
        }, "AutoZoom: keyframe de escala");
      }

      // f) DIAGNÓSTICO: lê de volta as posições reais dos keyframes vs as planejadas.
      let reais: number[] = [];
      try {
        reais = param.getKeyframeListAsTickTimes().map((t) => r3(t.seconds));
      } catch {
        /* readback é best-effort */
      }
      report("zoom-aplicado", {
        seg: cz.segmentIndex,
        rotulo,
        keyframesReais: reais,
        keyframesPlanejados: cz.keys.map((k) => ({ rel: r3(k.relSec), escala: k.scale })),
      });
      applied++;
    } catch (e) {
      report("zoom-erro-clip", {
        seg: cz.segmentIndex,
        rotulo,
        msg: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.slice(0, 500) : undefined,
      });
    }
  }

  report("zoom-fim", { aplicados: applied, deTotal: clipZooms.length });
  return { applied, diag };
}
