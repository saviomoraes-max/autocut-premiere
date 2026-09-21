# uso: python3 panel/dev/fotografar.py <bruto.mp4> <duracao_s> [porta=7867]
# Precisa: `npm --prefix panel run build`, o backend no ar e Playwright (pip install playwright).
# Percorre as telas do painel no banco de testes e fotografa cada uma.
# Largura do design (980) e do painel encaixado no Premiere (300).
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

H = Path(__file__).parent
SHOTS = H / "fotos"
SHOTS.mkdir(exist_ok=True)
MIDIA, DUR = sys.argv[1], sys.argv[2]
PORTA = sys.argv[3] if len(sys.argv) > 3 else "7867"
from urllib.parse import quote
URL = (H / "painel.html").as_uri() + f"?midia={quote(MIDIA)}&dur={DUR}&porta={PORTA}"


def botao(page, nome):
    return page.get_by_role("button", name=nome, exact=True).first


def foto(page, nome):
    page.wait_for_timeout(350)
    page.screenshot(path=str(SHOTS / f"{nome}.png"))
    print("foto:", nome, flush=True)


def esperar_texto(page, texto, timeout=180_000):
    page.get_by_text(texto, exact=False).first.wait_for(timeout=timeout)


def largo(p):
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 980, "height": 910})
    erros = []
    page.on("pageerror", lambda e: erros.append(str(e)))
    page.on("console", lambda m: erros.append(m.text) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_timeout(2500)
    foto(page, "01-configurar")

    botao(page, "SRT").click()
    foto(page, "06-exportar-srt")
    page.get_by_text("Cinema", exact=True).first.click()
    foto(page, "06b-exportar-srt-cinema")
    botao(page, "Voltar").click()

    botao(page, "Config").click()
    page.wait_for_timeout(1200)
    foto(page, "07-config")
    botao(page, "Voltar").click()

    botao(page, "Auto-Edit").click()
    page.wait_for_timeout(250)
    foto(page, "02-processar")
    esperar_texto(page, "cortes propostos")
    foto(page, "03-revisar-retakes")
    page.get_by_role("button", name="Blocos").first.click()
    foto(page, "03b-revisar-blocos")
    page.get_by_role("button", name="Cortes finos").first.click()
    foto(page, "03c-revisar-finos")
    botao(page, "Desmarcar todos").click()
    foto(page, "03d-revisar-finos-desmarcados")
    botao(page, "Voltar").click()

    botao(page, "Editar por texto").click()
    esperar_texto(page, "riscado = cortado")
    page.wait_for_timeout(800)
    foto(page, "04-editar-por-texto")
    botao(page, "Voltar").click()

    botao(page, "Auto-Zoom").click()
    esperar_texto(page, "propostos")
    foto(page, "05-auto-zoom")
    botao(page, "Voltar").click()

    # Erro: aponta o painel pra uma porta sem backend e dispara o Auto-Edit.
    botao(page, "Config").click()
    page.wait_for_timeout(600)
    campo = page.locator("input.cfg-input").first
    campo.fill("http://localhost:7999")
    botao(page, "Voltar").click()
    page.wait_for_timeout(800)
    botao(page, "Auto-Edit").click()
    esperar_texto(page, "BACKEND FORA DO AR", timeout=30_000)
    foto(page, "08-erro")

    # Vazio: some a sequência ativa.
    page.goto(URL + "&sem-sequencia")
    page.wait_for_timeout(3500)
    foto(page, "09-vazio")
    b.close()
    return erros


def estreito(p):
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 300, "height": 520})
    erros = []
    page.on("pageerror", lambda e: erros.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(2500)
    foto(page, "n01-configurar")
    page.mouse.wheel(0, 2000)
    foto(page, "n01b-configurar-rolado")
    page.mouse.wheel(0, -2000)
    botao(page, "Auto-Edit").click()
    page.wait_for_timeout(250)
    foto(page, "n02-processar")
    esperar_texto(page, "cortes propostos")
    foto(page, "n03-revisar")
    botao(page, "Voltar").click()
    botao(page, "SRT").click()
    foto(page, "n06-srt")
    b.close()
    return erros


with sync_playwright() as p:
    alvo = sys.argv[4] if len(sys.argv) > 4 else "tudo"
    erros = []
    if alvo in ("tudo", "largo"):
        erros += largo(p)
    if alvo in ("tudo", "estreito"):
        erros += estreito(p)
    print("erros de JS na página:", erros or "nenhum")
