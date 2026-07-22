#!/usr/bin/env python3
"""Detecção de NÃO-FALA via Silero VAD (rede neural fala vs. não-fala).

Por que existe: o silencedetect do ffmpeg decide por VOLUME (dB) — respiração,
ruído de sala e cauda de reverb são "som" e quebram uma pausa em pedaços curtos
demais pra virar corte (a pausa inteira escapa). O Silero classifica FALA de
verdade: respiro no meio da pausa continua sendo não-fala, então a pausa é
detectada inteira, e as bordas da fala saem precisas.

Entrada: WAV 16 kHz mono PCM 16-bit (o formato que o resolveAudio do backend
sempre produz). Lido com stdlib wave + numpy — de propósito, sem torchaudio
(o torchcodec do venv está quebrado; whisperx contorna igual).

Saída (stdout): JSON {"silences": [{"start": s, "end": e}, ...], "durationSec": d}
— regiões de não-fala em segundos, já filtradas por --min-sil.

Uso: vad_silence.py audio.wav [--min-sil 0.35] [--threshold 0.5] [--pad-ms 30]
"""
import argparse
import json
import sys
import wave

import numpy as np
import torch
from silero_vad import get_speech_timestamps, load_silero_vad


def ler_wav_16k_mono(path):
    """Lê WAV PCM 16-bit → tensor float32 [-1, 1]. Erro claro se o formato divergir."""
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        if sw != 2:
            raise SystemExit(f"esperado PCM 16-bit, veio sampwidth={sw}")
        raw = w.readframes(w.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:  # defensivo — o backend sempre manda mono
        audio = audio.reshape(-1, ch).mean(axis=1)
    if sr not in (8000, 16000):
        raise SystemExit(f"esperado 16 kHz (ou 8 kHz), veio {sr} Hz")
    return torch.from_numpy(audio.copy()), sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--min-sil", type=float, default=0.35, help="não-fala menor que isto (s) é ignorada")
    ap.add_argument("--threshold", type=float, default=0.5, help="limiar de probabilidade de fala do Silero")
    ap.add_argument("--pad-ms", type=int, default=30, help="acolchoado (ms) preservado nas bordas de cada trecho de fala")
    args = ap.parse_args()

    audio, sr = ler_wav_16k_mono(args.wav)
    duration = len(audio) / sr

    model = load_silero_vad()
    speech = get_speech_timestamps(
        audio,
        model,
        sampling_rate=sr,
        threshold=args.threshold,
        # pausa curta DENTRO da fala não separa segmentos (coeso com o min-sil de fora)
        min_silence_duration_ms=int(args.min_sil * 1000 * 0.8),
        speech_pad_ms=args.pad_ms,
        return_seconds=True,
    )

    # Complemento das regiões de fala = não-fala; filtra pelas >= min-sil.
    silences = []
    cursor = 0.0
    for seg in speech:
        if seg["start"] - cursor >= args.min_sil:
            silences.append({"start": round(cursor, 3), "end": round(seg["start"], 3)})
        cursor = max(cursor, seg["end"])
    if duration - cursor >= args.min_sil:
        silences.append({"start": round(cursor, 3), "end": round(duration, 3)})

    json.dump(
        {"silences": silences, "durationSec": round(duration, 3), "speechRegions": len(speech)},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
