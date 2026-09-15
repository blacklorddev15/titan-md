#!/usr/bin/env python3
"""
Generates the TITAN MD launcher/splash/brand assets.

Run from anywhere:  python3 android/tools/make_icon.py

Titan's palette (styles.css): black #050507, ink #0a0b0f, red #e5232b,
bright red #ff3a42, silver #d8dbe1. The site's .brand-mark is a red-bordered
slab with a skewed serif "T", so the icon is the same idea at icon scale.

Everything is drawn 4x and downsampled, which is cheaper than doing real AA.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

RED = (229, 35, 43)
RED_BRIGHT = (255, 58, 66)
RED_DARK = (93, 17, 26)
BLACK = (5, 5, 7)
INK = (10, 11, 15)
SILVER = (216, 219, 225)
MUTED = (157, 160, 168)

SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

SS = 4  # supersample factor
HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, "..", "app", "src", "main", "res"))


def vgrad(size, top, bottom):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size))


def radial(size, color, strength=190, inner=0.0, blur=0.20):
    """Soft centred glow, used to stop the flat black reading as dead space."""
    g = Image.new("L", (size, size), 0)
    ImageDraw.Draw(g).ellipse(
        [size * inner, size * inner, size * (1 - inner), size * (1 - inner)], fill=strength
    )
    g = g.filter(ImageFilter.GaussianBlur(size * blur))
    layer = Image.new("RGBA", (size, size), color + (0,))
    layer.putalpha(g)
    return layer


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def circle_mask(size, inset=0):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).ellipse([inset, inset, size - 1 - inset, size - 1 - inset], fill=255)
    return m


def glyph(text, size, font_path, font_frac, skew_deg=0.0, dy=0.0, color=(255, 255, 255, 255)):
    """A single centred text run on its own layer, optionally skewed like the site's mark."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    font = ImageFont.truetype(font_path, int(size * font_frac))
    ImageDraw.Draw(layer).text(
        (size / 2, size / 2 + dy * size), text, font=font, fill=color, anchor="mm"
    )
    if skew_deg:
        m = math.tan(math.radians(skew_deg))
        layer = layer.transform(
            layer.size, Image.AFFINE, (1, -m, m * size / 2, 0, 1, 0), resample=Image.BICUBIC
        )
    return layer


def tinted_gradient(size, mask, top, bottom):
    """Fill a mask's alpha with a vertical gradient."""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(vgrad(size, top, bottom), (0, 0), mask.split()[3])
    return out


def spaced_text(draw, xy, text, font, fill, tracking, anchor_center=True):
    """Letter-spaced text; PIL has no tracking, so lay out glyph by glyph."""
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x, y = xy
    if anchor_center:
        x -= total / 2
    for ch, w in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=fill, anchor="lm")
        x += w + tracking
    return total


def launcher_master(px=1024):
    """Full-bleed icon: dark slab, red glow, red border, skewed serif T."""
    base = Image.new("RGBA", (px, px), BLACK + (255,))
    base.alpha_composite(radial(px, RED_DARK, strength=210, inner=0.02, blur=0.26))
    base.alpha_composite(radial(px, RED, strength=105, inner=0.30, blur=0.13))

    inset = int(px * 0.055)
    bw = max(2, int(px * 0.019))
    ImageDraw.Draw(base).rounded_rectangle(
        [inset, inset, px - 1 - inset, px - 1 - inset],
        radius=int(px * 0.13),
        outline=RED + (235,),
        width=bw,
    )

    t = glyph("T", px, SERIF, 0.60, skew_deg=-8.0, dy=-0.012)
    base.alpha_composite(tinted_gradient(px, t, RED_BRIGHT, RED))

    mask = rounded_mask(px, int(px * 0.175))
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def foreground_master(px=1024):
    """Adaptive-icon foreground: transparent, T kept inside the 66% safe zone."""
    layer = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    layer.alpha_composite(radial(px, RED, strength=95, inner=0.24, blur=0.16))
    t = glyph("T", px, SERIF, 0.42, skew_deg=-8.0)
    layer.alpha_composite(tinted_gradient(px, t, RED_BRIGHT, RED))
    return layer


def brand_master(px=1024):
    """Loading screen: icon slab plus the TITAN / ANIME MD wordmark."""
    base = Image.new("RGBA", (px, px), BLACK + (255,))
    base.alpha_composite(radial(px, RED_DARK, strength=205, inner=0.02, blur=0.27))
    base.alpha_composite(radial(px, RED, strength=95, inner=0.32, blur=0.14))

    inset = int(px * 0.05)
    ImageDraw.Draw(base).rounded_rectangle(
        [inset, inset, px - 1 - inset, px - 1 - inset],
        radius=int(px * 0.12),
        outline=RED + (230,),
        width=max(2, int(px * 0.017)),
    )
    t = glyph("T", px, SERIF, 0.34, skew_deg=-8.0, dy=-0.155)
    base.alpha_composite(tinted_gradient(px, t, RED_BRIGHT, RED))

    d = ImageDraw.Draw(base)
    spaced_text(d, (px / 2, px * 0.685), "TITAN", ImageFont.truetype(SERIF, int(px * 0.115)),
                SILVER + (255,), px * 0.055)
    # tracking kept well clear of the slab border: at 0.075 the run measured wider than
    # the inner width and the trailing D collided with the frame.
    spaced_text(d, (px / 2, px * 0.805), "ANIME MD", ImageFont.truetype(SANS_B, int(px * 0.058)),
                RED_BRIGHT + (255,), px * 0.050)
    return base


def splash_master(px=1024):
    """Splash mark: circular, opaque only inside the ring so the splash bg shows through."""
    base = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    disc = Image.new("RGBA", (px, px), BLACK + (255,))
    disc.alpha_composite(radial(px, RED_DARK, strength=225, inner=0.0, blur=0.22))
    disc.alpha_composite(radial(px, RED, strength=110, inner=0.28, blur=0.12))
    ImageDraw.Draw(disc).ellipse(
        [px * 0.085, px * 0.085, px * 0.915, px * 0.915],
        outline=RED + (240,), width=max(2, int(px * 0.020)),
    )
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(disc, (0, 0), circle_mask(px, inset=int(px * 0.075)))

    t = glyph("T", px, SERIF, 0.34, skew_deg=-8.0)
    out.alpha_composite(tinted_gradient(px, t, RED_BRIGHT, RED))
    return out


def save(img, path, size, fmt=None, quality=92):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    resized = img.resize((size, size), Image.LANCZOS)
    if fmt == "WEBP":
        resized.save(path, "WEBP", quality=quality, method=6)
    else:
        resized.convert("RGBA").save(path, "PNG", optimize=True)
    print(f"    {os.path.relpath(path, RES):<52} {size}x{size}  {os.path.getsize(path):>7}B")


print("  mipmap launcher (legacy, full-bleed)")
lch = launcher_master()
for d, s in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    save(lch, f"{RES}/mipmap-{d}/ic_launcher.png", s)

print("  drawable-nodpi (adaptive foreground / brand / splash)")
save(foreground_master(), f"{RES}/drawable-nodpi/ic_launcher_foreground.webp", 432, "WEBP")
save(splash_master(), f"{RES}/drawable-nodpi/ic_splash_photo.webp", 384, "WEBP")
save(brand_master(), f"{RES}/drawable-nodpi/ic_brand_photo.webp", 432, "WEBP")

# preview sheet so the shapes can be eyeballed side by side on both backgrounds
sheet = Image.new("RGBA", (1180, 470), (18, 18, 20, 255))
for i, (label, master, size) in enumerate(
    [("launcher", lch, 200), ("foreground", foreground_master(), 200),
     ("splash", splash_master(), 200), ("brand", brand_master(), 200)]
):
    x = 25 + i * 290
    ImageDraw.Draw(sheet).rectangle([x - 10, 40, x + 220, 270], fill=BLACK + (255,))
    sheet.alpha_composite(master.resize((size, size), Image.LANCZOS), (x, 55))
    ImageDraw.Draw(sheet).text((x + 105, 300), label, font=ImageFont.truetype(SANS_B, 20),
                               fill=SILVER + (255,), anchor="mm")
sheet.convert("RGB").save(os.path.join(HERE, "icons_preview.png"))
print("\n  preview -> " + os.path.join(HERE, "icons_preview.png"))
