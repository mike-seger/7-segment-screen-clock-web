#!/usr/bin/env bash
set -euo pipefail

HTML="index.html"
CSS="style.css"
FONT="digital-7 (mono).ttf"
OUT="index-embedded.html"
TMP_CSS="style-embedded.css"

# 1) Check files exist
for f in "$HTML" "$CSS" "$FONT"; do
  if [ ! -f "$f" ]; then
    echo "Missing file: $f" >&2
    exit 1
  fi
done

echo "Embedding font into CSS..."

# 2) Base64-encode the font, single line (works on macOS and Linux)
FONT_B64=$(cat  "$FONT" | base64 | tr -d '\n')

# 3) Build data: URL
FONT_DATA_URI="data:font/ttf;base64,$FONT_B64"

# 4) Replace the URL in style.css with the data: URL
#    Original line:
#      src: url("digital-7 (mono).ttf") format("truetype");
sed "s|url(\"digital-7 (mono).ttf\")|url(\"$FONT_DATA_URI\")|g" "$CSS" > "$TMP_CSS"

echo "Creating embedded HTML..."

# 5) Create index-embedded.html by replacing the <link ...style.css> with <style>...</style>
#    We match any line that references style.css
{
  while IFS= read -r line; do
    if echo "$line" | grep -q 'href="style.css"'; then
      echo "<style>"
      cat "$TMP_CSS"
      echo "</style>"
    else
      echo "$line"
    fi
  done < "$HTML"
} > "$OUT"

rm -f style-embedded.css

echo "Done. Created: $OUT"
