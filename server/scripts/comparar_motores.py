#!/usr/bin/env python3
# Compara os motores de transcrição do AutoCut no MESMO bruto, pelas rotas reais do backend
# (as mesmas que o painel chama): /transcribe → /analyze → /srt (reels e cinema).
#
# Cada motor roda numa instância própria do backend (porta de teste), então o resultado é o que
# o painel veria com aquele motor ligado. Nada aqui escreve no bruto: tudo vai pra pasta de saída.
#
# uso:
#   python3 comparar_motores.py <video> <pasta_saida> rotulo=porta [rotulo=porta ...]
#   ex.: python3 comparar_motores.py bruto.mp4 saida whisperx=7891 scribe=7892 scribe_keyterms=7893
import json
import os
import re
import subprocess
import sys
import time
import urllib.request


def post(porta: int, rota: str, corpo: dict, timeout: int = 3600) -> dict:
    req = urllib.request.Request(
        f"http://localhost:{porta}{rota}",
        data=json.dumps(corpo).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def sondar(video: str) -> tuple[float, float]:
    """Duração (s) e fps do vídeo, via ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=r_frame_rate:format=duration", "-of", "json", video],
        capture_output=True, text=True, check=True,
    ).stdout
    d = json.loads(out)
    num, den = d["streams"][0]["r_frame_rate"].split("/")
    return float(d["format"]["duration"]), float(num) / float(den)


def texto_srt(srt: str) -> list[str]:
    return [l for l in srt.split("\n") if l.strip() and "-->" not in l and not re.fullmatch(r"\d+", l.strip())]


def main() -> None:
    video, saida, *motores = sys.argv[1:]
    os.makedirs(saida, exist_ok=True)
    dur, fps = sondar(video)
    clip = {"mediaPath": video, "inSec": 0, "outSec": round(dur, 3), "fps": fps}
    print(f"vídeo: {os.path.basename(video)} · {dur:.1f}s · {fps:.2f} fps\n")

    resumo = {}
    for par in motores:
        rotulo, porta = par.split("=")
        porta = int(porta)
        t0 = time.time()
        tr = post(porta, "/transcribe", {"clip": clip})
        t_trans = time.time() - t0
        transcript = tr["transcript"]
        an = post(porta, "/analyze", {"transcript": transcript, "clip": clip})
        # Igual ao painel: a legenda sai de uma transcrição PRÓPRIA no modo limpo (verbatim=false).
        # No WhisperX é a mesma transcrição (ele ignora o modo); no ElevenLabs é o no_verbatim.
        t1 = time.time()
        leg = post(porta, "/transcribe", {"clip": clip, "verbatim": False})["transcript"]
        t_leg = time.time() - t1
        with open(os.path.join(saida, f"{rotulo}.transcript-legenda.json"), "w", encoding="utf-8") as f:
            json.dump(leg, f, ensure_ascii=False, indent=1)
        srts = {}
        for estilo in ("reels", "cinema"):
            srts[estilo] = post(porta, "/srt", {"words": leg["words"], "offsetSec": 0, "leadSec": 0,
                                                "style": estilo, "fps": fps})["srt"]
            with open(os.path.join(saida, f"{rotulo}.{estilo}.srt"), "w", encoding="utf-8") as f:
                f.write(srts[estilo])
        with open(os.path.join(saida, f"{rotulo}.transcript.json"), "w", encoding="utf-8") as f:
            json.dump(transcript, f, ensure_ascii=False, indent=1)
        with open(os.path.join(saida, f"{rotulo}.analyze.json"), "w", encoding="utf-8") as f:
            json.dump(an, f, ensure_ascii=False, indent=1)

        palavras = transcript["words"]
        st = an["stats"]
        resumo[rotulo] = {
            "motor": transcript["engine"],
            "tempo_transcricao_s": round(t_trans, 1),
            "palavras": len(palavras),
            "falso_comeco_marcado": sum(1 for w in palavras if re.search(r"-+[.,;:!?…]*$", w["word"])),
            "cortes_por_motivo": st["porMotivo"],
            "segundos_removidos": round(st["duracaoRemovidaSec"], 1),
            "sinais_retake": {c: sum(1 for r in an.get("retakeSignals", []) if r["confidence"] == c) for c in ("alta", "baixa")},
            "marcadores": {c: sum(1 for m in an.get("markers", []) if m["confidence"] == c) for c in ("alta", "baixa")},
            "zoom": len(an.get("zoomPoints", [])),
            "legendas": {e: len(re.findall("-->", s)) for e, s in srts.items()},
            "tempo_transcricao_legenda_s": round(t_leg, 1),
            "algarismos_na_legenda": sum(1 for w in leg["words"] if re.search(r"\d", w["word"])),
        }
        print(f"[{rotulo}] {json.dumps(resumo[rotulo], ensure_ascii=False)}")

    with open(os.path.join(saida, "resumo.json"), "w", encoding="utf-8") as f:
        json.dump(resumo, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
