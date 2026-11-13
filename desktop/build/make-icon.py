# Generates the Wasipy app icons (PNG + ICO + tray PNG) from scratch.
# Run: python3 make-icon.py  (needs Pillow)
from PIL import Image, ImageDraw, ImageFont

import os

SIZE = 512
RADIUS = 112
# Brand gradient stops (top -> bottom): indigo -> violet -> blue
STOPS = [(79, 70, 229), (124, 58, 237), (37, 99, 235)]
# Bold font candidates (Linux, Windows, macOS) — first one that exists wins.
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def gradient(size, stops):
    img = Image.new("RGB", (size, size))
    px = img.load()
    n = len(stops) - 1
    for y in range(size):
        t = y / max(size - 1, 1) * n
        i = min(int(t), n - 1)
        f = t - i
        c0, c1 = stops[i], stops[i + 1]
        c = tuple(round(c0[k] + (c1[k] - c0[k]) * f) for k in range(3))
        for x in range(size):
            px[x, y] = c
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def main():
    base = gradient(SIZE, STOPS).convert("RGBA")
    base.putalpha(rounded_mask(SIZE, RADIUS))
    d = ImageDraw.Draw(base)
    font = None
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            try:
                font = ImageFont.truetype(candidate, 300)
                break
            except OSError:
                continue
    if font is None:
        font = ImageFont.load_default()
    d.text(
        (SIZE / 2, SIZE / 2 - 14),
        "W",
        font=font,
        fill=(255, 255, 255, 255),
        anchor="mm",
    )
    base.save("icon.png")
    base.resize((32, 32), Image.LANCZOS).save("tray.png")
    base.save(
        "icon.ico",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )
    print("wrote icon.png, tray.png, icon.ico")


if __name__ == "__main__":
    main()
