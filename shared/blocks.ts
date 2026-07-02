// Lógica pura (sem dependências) da SEGMENTAÇÃO do bruto longo em BLOCOS.
//
// O chefe grava um bruto único com TODOS os anúncios/reels e FALA um marcador ao abrir
// cada peça ("claquete", "lead 2", "corpo 1"). Cada marcador CONFIRMADO abre um bloco;
// o bloco vai até o próximo marcador (ou o fim do stream). Cada bloco vira UMA sequência
// (opção A) — escala pequena por sequência = MATA o crash de bulk-edit do UXP.
//
// Tudo aqui opera em tempo ACHATADO (0 = início do 1º clipe), o mesmo domínio da
// transcrição, dos marcadores e dos cortes. Compartilhado painel <-> servidor.
import type { Cut, KeepSegment, Marker, RetakeSignal } from "./types";

/**
 * Rebaixa pra "baixa" o marcador que é um RE-SLATE: o chefe refaz o take e re-claca o MESMO
 * rótulo. O corte de retake já cobre esse trecho, então o re-slate não deve abrir uma
 * sequência-lixo curta. Assinatura (aterrada no caso real "Corpo 2" re-clacado ~8s depois de
 * "vou gravar de novo", 2026-06-23): existe um marcador ANTERIOR de MESMO rótulo, com um sinal
 * de retake (alta) ENTRE os dois, e este marcador vem logo após esse retake (≤ withinSec).
 *
 * O par "mesmo rótulo" é essencial: sem ele, um "não gostei" que rejeita o lead anterior
 * rebaixaria por engano o PRÓXIMO bloco real (ex.: "Lead 4"). Espera marcadores em ordem
 * de tempo (como detectMarkers devolve).
 */
export function demoteMarkersAfterRetake(
  markers: ReadonlyArray<Marker>,
  signals: ReadonlyArray<RetakeSignal>,
  withinSec = 20,
): Marker[] {
  const high = signals.filter((s) => s.confidence === "alta");
  return markers.map((m, i) => {
    // Marcador anterior de MESMO rótulo.
    let prevSame: Marker | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (markers[j].label === m.label) {
        prevSame = markers[j];
        break;
      }
    }
    if (!prevSame) return m;
    // Retake (alta) entre o anterior-mesmo-rótulo e este, e este vem logo depois do retake.
    const reslate = high.some(
      (s) =>
        s.startSec > prevSame!.startSec &&
        s.endSec <= m.startSec &&
        m.startSec - s.endSec <= withinSec,
    );
    return reslate ? { ...m, confidence: "baixa" as const } : m;
  });
}

/** Um bloco do bruto = trecho entre dois marcadores confirmados. Vira UMA sequência. */
export interface Block {
  /** Rótulo que nomeia a sequência ("Corpo 1", "Lead 2", "Claquete"). */
  label: string;
  /** Início no stream achatado (s). */
  startSec: number;
  /** Fim no stream achatado (s) = início do próximo bloco (ou fim do stream). */
  endSec: number;
  /** Índice do marcador que abriu o bloco (-1 = bloco-intro, antes do 1º marcador). */
  markerIndex: number;
}

export interface BuildBlocksOptions {
  /** O bloco ANTES do 1º marcador (intro/sobra) só entra se durar ≥ isto (s). */
  minLeadInSec?: number;
}

/**
 * Monta os blocos a partir dos marcadores CONFIRMADOS (já filtrados pelo humano).
 * Sem marcador nenhum → um único bloco com tudo (= comportamento de sequência única,
 * degradação suave). Com marcadores → um bloco por marcador, em ordem de tempo.
 */
export function buildBlocks(
  markers: ReadonlyArray<Marker>,
  totalSec: number,
  opts: BuildBlocksOptions = {},
): Block[] {
  const minLeadIn = opts.minLeadInSec ?? 8;
  const ms = [...markers].sort((a, b) => a.startSec - b.startSec);
  const blocks: Block[] = [];

  // Sem marcador: um bloco só com o stream inteiro.
  if (!ms.length) {
    return [{ label: "Sequência", startSec: 0, endSec: totalSec, markerIndex: -1 }];
  }

  // Trecho ANTES do 1º marcador (intro/sobra) — só vira bloco se for substancial.
  if (ms[0].startSec >= minLeadIn) {
    blocks.push({
      label: "Início (antes do 1º marcador)",
      startSec: 0,
      endSec: ms[0].startSec,
      markerIndex: -1,
    });
  }

  for (let i = 0; i < ms.length; i++) {
    const start = ms[i].startSec;
    const end = i + 1 < ms.length ? ms[i + 1].startSec : totalSec;
    if (end - start <= 0) continue; // marcadores no mesmo instante: ignora o vazio
    blocks.push({ label: ms[i].label, startSec: start, endSec: end, markerIndex: i });
  }
  return blocks;
}

/** Os sinais de retake que caem DENTRO de um bloco, em ordem de tempo. */
export function signalsInBlock(
  block: Block,
  signals: ReadonlyArray<RetakeSignal>,
): RetakeSignal[] {
  return signals
    .filter((s) => s.startSec >= block.startSec && s.startSec < block.endSec)
    .sort((a, b) => a.startSec - b.startSec);
}

/**
 * Corte de retake de UM bloco. O chefe anuncia que vai refazer ("vou ler de novo"),
 * então tudo do INÍCIO do bloco até o ÚLTIMO sinal habilitado é take descartado — o take
 * bom é o que vem depois. Como cada "de novo" invalida o que veio antes, só o último
 * sinal define a fronteira → no máximo UM corte por bloco. Devolve null se nada a cortar.
 */
export function retakeCutForBlock(
  block: Block,
  enabledSignals: ReadonlyArray<RetakeSignal>,
): Cut | null {
  const inBlock = signalsInBlock(block, enabledSignals);
  if (!inBlock.length) return null;
  const last = inBlock[inBlock.length - 1];
  if (last.endSec - block.startSec <= 0.1) return null; // nada útil a remover
  return {
    start: block.startSec,
    end: last.endSec,
    reason: "bad_take",
    detail: `retake: descarta o take antes de "${last.phrase}"`,
  };
}

/**
 * Interseção dos KEEPS (em tempo achatado, offset 0) com a janela [startSec, endSec] de
 * um bloco. É como uma sequência só "vê" o seu próprio pedaço do stream — a fatia 0 do
 * bloco vira o início (0) da sequência dele.
 */
export function restrictKeepsToWindow(
  keeps: ReadonlyArray<KeepSegment>,
  startSec: number,
  endSec: number,
): KeepSegment[] {
  const out: KeepSegment[] = [];
  for (const k of keeps) {
    const a = Math.max(k.start, startSec);
    const b = Math.min(k.end, endSec);
    if (b - a > 1e-6) out.push({ start: a, end: b });
  }
  return out;
}
