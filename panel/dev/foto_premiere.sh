#!/bin/zsh
# Fotografa SÓ a janela do Premiere (nunca a tela inteira) e recorta a região do painel AutoCut.
# Uso: panel/dev/foto_premiere.sh <saida.png> [x y largura altura em pixels da janela]
# Precisa de Gravação de Tela liberada pro VS Code. O recorte padrão é o painel encaixado ao lado
# do Projeto no layout de edição do Sávio — mude os números se o painel estiver em outro lugar.
set -e
saida=${1:?informe o arquivo de saída}
x=${2:-932}; y=${3:-120}; w=${4:-1110}; h=${5:-980}
id=$(swift - <<'SWIFT'
import CoreGraphics
let l = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
var melhor = 0, area = 0
for j in l where (j[kCGWindowOwnerName as String] as? String ?? "").contains("Premiere") {
  let b = j[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let a = ((b["Width"] as? Int) ?? 0) * ((b["Height"] as? Int) ?? 0)
  if a > area { area = a; melhor = j[kCGWindowNumber as String] as? Int ?? 0 }
}
print(melhor)
SWIFT
)
tmp=$(mktemp -t premiere).png
screencapture -x -o -l "$id" "$tmp"
python3 -c "
from PIL import Image
im = Image.open('$tmp'); im.crop(($x, $y, $x + $w, $y + $h)).save('$saida')
"
rm -f "$tmp"
echo "$saida"
