# Generates the Wasipy Android icons + splash screens from scratch.
# Why a script: the PNGs cannot be committed through the GitHub App (it
# rejects binary files), so the CI workflow runs this before the Gradle
# build and the images are generated fresh every time.
# Run: python3 make-android-icons.py  (needs Pillow; run from mobile/)
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
# Brand gradient stops (top -> bottom): indigo -> violet -> blue
STOPS = [(79, 70, 229), (124, 58, 237), (37, 99, 235)]
BG = (245, 245, 242)  # warm paper, matches the Wasipy site
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]

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
    return img.convert("RGBA")


def font_for(px):
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, px)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_w(img, size, font_px):
    d = ImageDraw.Draw(img)
    d.text(
        (size / 2, size / 2 - size * 0.03),
        "W",
        font=font_for(font_px),
        fill=(255, 255, 255, 255),
        anchor="mm",
    )


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
        # Legacy launcher: gradient rounded square + W.
        icon = gradient(icon_px, STOPS)
        icon.putalpha(rounded_mask(icon_px, round(icon_px * 0.22)))
        draw_w(icon, icon_px, round(icon_px * 0.58))
        icon.save(os.path.join(folder, "ic_launcher.png"))
        # Round launcher: gradient circle + W.
        rnd = gradient(icon_px, STOPS)
        rnd.putalpha(circle_mask(icon_px))
        draw_w(rnd, icon_px, round(icon_px * 0.58))
        rnd.save(os.path.join(folder, "ic_launcher_round.png"))
        # Adaptive foreground: full-bleed gradient + W (the launcher masks
        # the shape; the W stays inside the 66dp safe zone).
        fg = gradient(fg_px, STOPS)
        draw_w(fg, fg_px, round(fg_px * 0.52))
        fg.save(os.path.join(folder, "ic_launcher_foreground.png"))
    for folder, w, h in SPLASHES:
        path = os.path.join(RES, folder)
        os.makedirs(path, exist_ok=True)
        img = Image.new("RGB", (w, h), BG).convert("RGBA")
        s = round(min(w, h) * 0.28)
        mark = gradient(s, STOPS)
        mark.putalpha(rounded_mask(s, round(s * 0.22)))
        draw_w(mark, s, round(s * 0.58))
        img.paste(mark, ((w - s) // 2, (h - s) // 2), mark)
        img.convert("RGB").save(os.path.join(path, "splash.png"))
    print("wrote android launcher icons + splash screens")


if __name__ == "__main__":
    main()
