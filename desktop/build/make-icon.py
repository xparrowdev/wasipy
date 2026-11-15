# Generates the Wasipy app icons (PNG + ICO + tray PNG) from scratch.
# Run: python3 make-icon.py  (needs Pillow)
from PIL import Image, ImageDraw

SIZE = 512
RADIUS = 112  # ~22% of 512, matches the logo's corner radius
# Brand colors from the official logo (Primary_logo.png):
NAVY = (11, 27, 58)      # #0b1b3a — the rounded square
ORANGE = (255, 176, 32)  # #ffb020 — the dot

# W polyline + dot in a 0-100 box (traced from the official logo)
W_POINTS = [(22, 30), (36, 66), (50, 43), (64, 66), (78, 35)]
W_WIDTH = 11.5
DOT = (80, 30, 7.5)  # cx, cy, r in the 0-100 box


def draw_mark(img, size):
    """Draw the white W + orange dot, centered, in a size x size image."""
    d = ImageDraw.Draw(img)
    cx = cy = size / 2

    def pt(x, y):
        return (cx + (x - 50) * size / 100, cy + (y - 50) * size / 100)

    w = max(1, round(W_WIDTH * size / 100))
    pts = [pt(x, y) for x, y in W_POINTS]
    d.line(pts, fill=(255, 255, 255, 255), width=w, joint="curve")
    # round caps (PIL lines have flat ends)
    for x, y in (pts[0], pts[-1]):
        r = w / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))
    dx, dy = pt(DOT[0], DOT[1])
    dr = DOT[2] * size / 100
    d.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=ORANGE + (255,))


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def main():
    base = Image.new("RGBA", (SIZE, SIZE), NAVY + (255,))
    base.putalpha(rounded_mask(SIZE, RADIUS))
    draw_mark(base, SIZE)
    base.save("icon.png")
    base.resize((32, 32), Image.LANCZOS).save("tray.png")
    base.save(
        "icon.ico",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )
    print("wrote icon.png, tray.png, icon.ico")


if __name__ == "__main__":
    main()
