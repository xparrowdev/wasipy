# Generates the Wasipy Android icons + splash screens from scratch.
# Why a script: the PNGs cannot be committed through the GitHub App (it
# rejects binary files), so the CI workflow runs this before the Gradle
# build and the images are generated fresh every time.
# Run: python3 make-android-icons.py  (needs Pillow; run from mobile/)
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
# Brand colors from the official logo (Primary_logo.png):
NAVY = (11, 27, 58)      # #0b1b3a — the rounded square
ORANGE = (255, 176, 32)  # #ffb020 — the dot
BG = (245, 245, 242)  # warm paper, matches the Wasipy site

# W polyline + dot in a 0-100 box (traced from the official logo)
W_POINTS = [(22, 30), (36, 66), (50, 43), (64, 66), (78, 35)]
W_WIDTH = 11.5
DOT = (80, 30, 7.5)  # cx, cy, r in the 0-100 box

# density -> (legacy icon px, adaptive foreground px)
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}
# splash drawables: (folder, width, height)
SPLASHES = [
    ("drawable", 480, 320),
    ("drawable-land-mdpi", 480, 320),
    ("drawable-land-hdpi", 800, 480),
    ("drawable-land-xhdpi", 1280, 720),
    ("drawable-land-xxhdpi", 1600, 960),
    ("drawable-land-xxxhdpi", 1920, 1280),
    ("drawable-port-mdpi", 320, 480),
    ("drawable-port-hdpi", 480, 800),
    ("drawable-port-xhdpi", 720, 1280),
    ("drawable-port-xxhdpi", 960, 1600),
    ("drawable-port-xxxhdpi", 1280, 1920),
]


def draw_mark(img, size, scale=1.0):
    """Draw the white W + orange dot, centered, in a size x size image."""
    d = ImageDraw.Draw(img)
    cx = cy = size / 2

    def pt(x, y):
        return (cx + (x - 50) * scale * size / 100,
                cy + (y - 50) * scale * size / 100)

    w = max(1, round(W_WIDTH * scale * size / 100))
    pts = [pt(x, y) for x, y in W_POINTS]
    d.line(pts, fill=(255, 255, 255, 255), width=w, joint="curve")
    # round caps (PIL lines have flat ends)
    for x, y in (pts[0], pts[-1]):
        r = w / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))
    dx, dy = pt(DOT[0], DOT[1])
    dr = DOT[2] * scale * size / 100
    d.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=ORANGE + (255,))


def solid(size, color):
    return Image.new("RGBA", (size, size), color + (255,))


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def circle_mask(size):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([0, 0, size - 1, size - 1], fill=255)
    return mask


def main():
    for density, (icon_px, fg_px) in DENSITIES.items():
        folder = os.path.join(RES, f"mipmap-{density}")
        os.makedirs(folder, exist_ok=True)
        # Legacy launcher: navy rounded square + W + dot.
        icon = solid(icon_px, NAVY)
        icon.putalpha(rounded_mask(icon_px, round(icon_px * 0.22)))
        draw_mark(icon, icon_px)
        icon.save(os.path.join(folder, "ic_launcher.png"))
        # Round launcher: navy circle + W + dot.
        rnd = solid(icon_px, NAVY)
        rnd.putalpha(circle_mask(icon_px))
        draw_mark(rnd, icon_px)
        rnd.save(os.path.join(folder, "ic_launcher_round.png"))
        # Adaptive foreground: full-bleed navy + W + dot, drawn at 80%
        # so the mark stays inside the launcher's 66dp safe zone.
        fg = solid(fg_px, NAVY)
        draw_mark(fg, fg_px, scale=0.8)
        fg.save(os.path.join(folder, "ic_launcher_foreground.png"))
    for folder, w, h in SPLASHES:
        path = os.path.join(RES, folder)
        os.makedirs(path, exist_ok=True)
        img = Image.new("RGB", (w, h), BG).convert("RGBA")
        s = round(min(w, h) * 0.28)
        mark = solid(s, NAVY)
        mark.putalpha(rounded_mask(s, round(s * 0.22)))
        draw_mark(mark, s)
        img.paste(mark, ((w - s) // 2, (h - s) // 2), mark)
        img.convert("RGB").save(os.path.join(path, "splash.png"))
    print("wrote android launcher icons + splash screens")


if __name__ == "__main__":
    main()
