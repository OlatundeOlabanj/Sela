# Regenerates the raster brand assets (favicons, touch icon, social card)
# from the Sela mark. Run from the repo root: python3 tools/generate-brand-assets.py
# Needs Pillow. Uses DejaVu Sans Bold for the social card text because
# Space Grotesk is not installed on the build machine.
# Made by TJS Code
from PIL import Image, ImageDraw, ImageFont

BG = (5, 8, 15, 255)
AMBER = (245, 158, 11)
GOLD = (244, 199, 82)

def mark(size):
    s = 8
    S = size * s
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.29), fill=AMBER + (56,))
    c = S / 2
    r = S * 0.267
    w = max(2, int(S * 0.071))
    d.ellipse([c - r, c - r, c + r, c + r], outline=AMBER + (64,), width=w)
    d.arc([c - r, c - r, c + r, c + r], start=-90, end=180, fill=GOLD + (255,), width=w)
    dot = S * 0.065
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=GOLD + (255,))
    return img.resize((size, size), Image.LANCZOS)

def on_dark(size):
    base = Image.new("RGBA", (size, size), BG)
    base.alpha_composite(mark(size))
    return base

on_dark(16).save("assets/favicon-16.png")
on_dark(32).save("assets/favicon-32.png")
on_dark(180).save("assets/apple-touch-icon.png")

W, H = 1200, 630
card = Image.new("RGBA", (W, H), BG)
d = ImageDraw.Draw(card)
for x in range(0, W, 40):
    for y in range(0, H, 40):
        d.ellipse([x, y, x + 2, y + 2], fill=AMBER + (40,))
card.alpha_composite(mark(150), (90, 150))
bold = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
reg = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
mono = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
d.text((270, 140), "Se", font=ImageFont.truetype(bold, 130), fill=(240, 240, 240))
sw = d.textlength("Se", font=ImageFont.truetype(bold, 130))
d.text((270 + sw, 140), "la", font=ImageFont.truetype(bold, 130), fill=(224, 160, 32))
d.text((90, 360), "Shared savings goals on Solana", font=ImageFont.truetype(bold, 52), fill=(240, 240, 240))
d.text((90, 440), "Fund goals in USDC. Payments submitted through Jito bundles.", font=ImageFont.truetype(reg, 30), fill=(160, 165, 175))
d.text((90, 550), "Made by TJS Code", font=ImageFont.truetype(mono, 24), fill=(224, 160, 32))
card.convert("RGB").save("assets/og-image.png")
print("brand assets written")
