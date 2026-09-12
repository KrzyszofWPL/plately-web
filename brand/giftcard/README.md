# Karta podarunkowa — źródła

Grafika karty z `/giftcards/<link>` (`public/giftcards.html`). Tu leżą pliki
projektowe; strona czyta wyłącznie zoptymalizowane kopie z `public/giftcard/`.

| plik | co to jest |
| --- | --- |
| `PSD.psd` | projekt z warstwami — edytuj ten |
| `Giftcard.png` | pełna, wypełniona wersja (podgląd, jak ma wyglądać ULTRA / 366 DNI) |
| `Semi.png` | karta + „PLATELY” + logo, **bez** polskich napisów — z tego jest `public/giftcard/front.webp` |
| `Raw.png` | samo tło — z tego jest `public/giftcard/back.webp` (rewers z kodem) |

Napisy („KOD CYFROWY”, plan i liczba dni, hasło na dole) strona nakłada sama,
tekstem HTML na `front.webp` — dzięki temu ta sama grafika obsługuje Premium
i Ultra, każdą długość i oba języki. Pozycje i rozmiary w `.over` w
`giftcards.html` są odwzorowane z `Giftcard.png`.

## Po zmianie projektu

Wyeksportuj nowe `Semi.png` i `Raw.png` (1017×1465, PNG z przezroczystością —
rogi i otwór na wieszak), a potem przelicz kopie dla strony:

```bash
python -c "
from PIL import Image
for src, dst in (('brand/giftcard/Semi.png','public/giftcard/front.webp'),('brand/giftcard/Raw.png','public/giftcard/back.webp')):
    im = Image.open(src).convert('RGBA'); w, h = im.size
    im.resize((800, round(h*800/w)), Image.LANCZOS).save(dst, 'WEBP', quality=86, method=6)
"
```

Osiemset pikseli szerokości starcza na kartę wyświetlaną w 340 px na ekranie
2× — a WebP zamiast megabajtowego PNG to różnica między prezentem, który się
otwiera, a kółkiem ładowania na telefonie.
