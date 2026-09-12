# Karta podarunkowa — źródła

Grafika karty z `/giftcards/<link>` (`public/gift.html`; `public/giftcards.html`
to sklep). Tu leżą pliki
projektowe; strona czyta wyłącznie zoptymalizowane kopie z `public/giftcard/`.

| plik | co to jest |
| --- | --- |
| `PSD.psd` | projekt z warstwami — edytuj ten |
| `Giftcard.png` | pełna, wypełniona wersja (podgląd, jak ma wyglądać ULTRA / 366 DNI) |
| `Semi.png` | karta + „PLATELY” + logo, **bez** polskich napisów — z tego jest `public/giftcard/front.webp` |
| `Raw.png` | samo tło — jego **kanał alfa** (rogi i otwór na wieszak) daje biały rewers `public/giftcard/back.webp`; sam obraz nie jest używany |
| `Wrapped.png` | zapakowana karta (czerwony papier, biała kokarda) — stan przed rozpakowaniem, `public/giftcard/wrapped.webp` |

Napisy („KOD CYFROWY”, plan i liczba dni, hasło na dole) strona nakłada sama,
tekstem HTML na `front.webp` — dzięki temu ta sama grafika obsługuje Premium
i Ultra, każdą długość i oba języki. Pozycje i rozmiary w `.over` w
`gift.html` są odwzorowane z `Giftcard.png`: bloki w rogach są
wyśrodkowane same w sobie („KOD” nad „CYFROWY”), a hasło na dole ma kilka
warstw cienia — to odpowiednik potrójnej kopii warstwy z PSD.

Rewers jest biały i rysowany w całości w HTML — z PSD bierze tylko wykrój.
Pod zdrapką jest sam kod; kod QR w rogu prowadzi na `plately.eu` i nic
więcej nie niesie, a kod kreskowy — tylko datę wydania i ID karty (obie
rzeczy wypisane pod nim). Napisy na stronie i na karcie są w dwunastu
językach aplikacji — słownik w `public/giftcard/i18n.js`, generator QR w
`public/giftcard/qr.js`.

## Po zmianie projektu

Wyeksportuj nowe `Semi.png` i `Raw.png` (1017×1465, PNG z przezroczystością —
rogi i otwór na wieszak), a potem przelicz kopie dla strony:

```bash
python -c "
from PIL import Image
def out(im, dst, q=86):
    w, h = im.size; im.resize((800, round(h*800/w)), Image.LANCZOS).save(dst, 'WEBP', quality=q, method=6)
out(Image.open('brand/giftcard/Semi.png').convert('RGBA'), 'public/giftcard/front.webp')
out(Image.open('brand/giftcard/Wrapped.png').convert('RGBA'), 'public/giftcard/wrapped.webp', 88)
raw = Image.open('brand/giftcard/Raw.png').convert('RGBA')
white = Image.new('RGBA', raw.size, (250, 250, 248, 255)); white.putalpha(raw.split()[3])
out(white, 'public/giftcard/back.webp', 90)
"
```

Osiemset pikseli szerokości starcza na kartę wyświetlaną w 340 px na ekranie
2× — a WebP zamiast megabajtowego PNG to różnica między prezentem, który się
otwiera, a kółkiem ładowania na telefonie.
