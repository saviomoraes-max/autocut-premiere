# uso: python3 panel/dev/interacoes.py <bruto.mp4> <duracao_s> [porta=7867]
# Precisa: `npm --prefix panel run build`, o backend no ar e Playwright (pip install playwright).
# Confere o COMPORTAMENTO do painel novo (não só o visual): cada clique produz o efeito certo.
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

H = Path(__file__).parent
MIDIA, DUR = sys.argv[1], sys.argv[2]
PORTA = sys.argv[3] if len(sys.argv) > 3 else "7867"
from urllib.parse import quote
URL = (H / "painel.html").as_uri() + f"?midia={quote(MIDIA)}&dur={DUR}&porta={PORTA}"
resultados = []


def confere(nome, cond, detalhe=""):
    resultados.append((nome, bool(cond), detalhe))
    print(("OK   " if cond else "FALHA"), nome, ("— " + detalhe) if detalhe else "", flush=True)


def txt(page, sel):
    return page.locator(sel).first.inner_text().strip()


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 980, "height": 910})
    erros = []
    page.on("pageerror", lambda e: erros.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(2500)

    # --- home ---
    confere("fonte mostra a sequência simulada", txt(page, ".source-name") == MIDIA.split("/")[-1], txt(page, ".source-name"))
    page.get_by_role("button", name="Corte agressivo", exact=True).click()
    page.get_by_role("button", name="Sem filler", exact=True).click()
    v = page.locator("textarea").input_value()
    confere("atalhos anexam ao prompt", v == "Corte agressivo, sem filler", repr(v))
    page.locator(".num-stepper button").nth(1).click()
    page.locator(".num-stepper button").nth(1).click()
    confere("sincronia soma 0,1 com vírgula", "0,2 s" in txt(page, ".num-stepper"), txt(page, ".num-stepper"))
    page.get_by_role("button", name="Seco", exact=True).click()
    confere("respiro troca a pílula ativa", txt(page, ".seg-opt.on") == "Seco", txt(page, ".seg-opt.on"))

    # --- cancelar durante o processamento ---
    page.get_by_role("button", name="Auto-Edit", exact=True).click()
    page.wait_for_timeout(150)
    page.get_by_role("button", name="Cancelar", exact=True).click()
    page.wait_for_timeout(1500)
    confere("cancelar volta pra home sem erro", page.locator("text=Rough cut").count() > 0 and page.locator("text=ALGO DEU ERRADO").count() == 0)
    confere("respiro escolhido sobrevive à volta", txt(page, ".seg-opt.on") == "Seco")

    # --- revisão ---
    page.get_by_role("button", name="Auto-Edit", exact=True).click()
    page.get_by_text("cortes propostos").first.wait_for(timeout=180_000)
    antes = txt(page, ".dur-new")
    rodape_antes = txt(page, ".foot-text")
    page.locator(".rcard").first.click()  # marca o 1º retake
    page.wait_for_timeout(200)
    depois = txt(page, ".dur-new")
    confere("marcar retake muda a duração final", antes != depois, f"{antes} → {depois}")
    confere("rodapé conta o retake aceito", "1 retake aceito" in txt(page, ".foot-text"), txt(page, ".foot-text"))
    confere("aba Retakes mostra 1/3", "1/3" in txt(page, ".tab.on"), txt(page, ".tab.on"))
    page.locator(".rcard").first.click()  # desmarca de volta
    page.wait_for_timeout(200)
    confere("desmarcar devolve a duração", txt(page, ".dur-new") == antes, txt(page, ".dur-new"))

    page.get_by_role("button", name="Cortes finos").first.click()
    marcados = page.locator(".rcard.on").count()
    page.get_by_role("button", name="Desmarcar todos", exact=True).click()
    page.wait_for_timeout(200)
    confere("desmarcar todos (finos) desmarca os cartões", page.locator(".rcard.on").count() == 0, f"{marcados} → {page.locator('.rcard.on').count()}")
    confere("rodapé zera os cortes finos", "0 cortes finos" in txt(page, ".foot-text"), txt(page, ".foot-text"))
    confere("duração volta ao total sem cortes", txt(page, ".dur-new") == txt(page, ".dur-old"), f"{txt(page, '.dur-new')} vs {txt(page, '.dur-old')}")
    page.get_by_role("button", name="Retakes").first.click()
    confere("lote não mexeu nos retakes", "0/3" in txt(page, ".tab.on"), txt(page, ".tab.on"))
    page.get_by_role("button", name="Cortes finos").first.click()
    page.get_by_role("button", name="Marcar todos", exact=True).click()
    page.wait_for_timeout(200)
    confere("marcar todos (finos) remarca", page.locator(".rcard.on").count() == marcados, f"{page.locator('.rcard.on').count()} de {marcados}")
    page.get_by_role("button", name="Voltar", exact=True).click()

    # --- editar por texto ---
    page.get_by_role("button", name="Editar por texto", exact=True).click()
    page.get_by_text("riscado = cortado").first.wait_for(timeout=180_000)
    rod0 = txt(page, ".foot-text")
    n0 = int(rod0.split(" ")[0])
    alvo = page.locator(".tw").nth(3)
    estava = "del" in (alvo.get_attribute("class") or "")
    alvo.click()
    page.wait_for_timeout(150)
    n1 = int(txt(page, ".foot-text").split(" ")[0])
    confere("clicar palavra altera a contagem", n1 == (n0 - 1 if estava else n0 + 1), f"{n0} → {n1}")
    page.locator(".te-toggle").click()
    page.wait_for_timeout(150)
    confere("desligar silêncios zera os respiros", "0 respiros" in txt(page, ".foot-text"), txt(page, ".foot-text"))

    b.close()
    confere("sem erro de JavaScript na página", not erros, "; ".join(erros))

falhas = [r for r in resultados if not r[1]]
print(f"\n{len(resultados) - len(falhas)}/{len(resultados)} conferências OK")
