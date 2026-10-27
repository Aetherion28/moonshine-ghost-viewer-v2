"""Draws the viewer's decorative pixel sprites into web/legacy/ (build.mjs copies them into site/).

Original art, drawn here from primitives: a palm, a sun, a fish, a steamship, a pointing hand and a
gamepad. Each PNG is a strip of two frames side by side; the page swaps them with CSS steps().
Run:  python3 web/make_sprites.py
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'legacy')
S = 4  # each art pixel is drawn S screen pixels wide

INK = (40, 28, 14, 255)
GREEN = (72, 170, 70, 255); GREEN2 = (40, 120, 50, 255)
TRUNK = (170, 110, 50, 255); TRUNK2 = (110, 70, 30, 255)
GOLD = (250, 200, 60, 255); GOLD2 = (230, 150, 30, 255)
FISH = (240, 170, 60, 255); FISH2 = (200, 120, 30, 255)
HULL = (60, 60, 70, 255); RED = (200, 50, 50, 255); WHITE = (250, 248, 235, 255)
SMOKE = (210, 210, 210, 255); WATER = (90, 170, 220, 255)
PAD = (110, 90, 170, 255); PAD2 = (70, 55, 120, 255); GREY = (150, 150, 150, 255)


def frame(w, h):
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def outline(im):
    """One-pixel ink outline around everything opaque, like hand-drawn doodles."""
    w, h = im.size
    px = im.load()
    out = im.copy(); op = out.load()
    for y in range(h):
        for x in range(w):
            if px[x, y][3]: continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3]:
                    op[x, y] = INK; break
    return out


def strip(name, frames, w, h):
    out = Image.new('RGBA', (w * S * 2, h * S), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        f = outline(f).resize((w * S, h * S), Image.NEAREST)
        out.paste(f, (i * w * S, 0))
    out.save(os.path.join(OUT, name))
    print(name, out.size)


def palm(lean):
    im, d = frame(20, 18)
    d.line([(10, 17), (10 + lean, 6)], fill=TRUNK, width=2)
    for y in range(7, 17, 3): d.point((10, y), fill=TRUNK2)
    cx = 10 + lean
    for ang, col in ((-6, GREEN), (6, GREEN), (-3, GREEN2), (3, GREEN2), (0, GREEN)):
        d.line([(cx, 6), (cx + ang, 2 + abs(ang) // 2)], fill=col, width=2)
        d.line([(cx, 6), (cx + ang * 1.3, 7 + abs(ang) // 3)], fill=col, width=2)
    d.ellipse([cx - 1, 5, cx + 1, 7], fill=TRUNK2)
    return im


def sun(spin):
    im, d = frame(16, 18)
    px = im.load()
    rays = ((8, 1), (8, 17), (1, 9), (15, 9)) if not spin else ((3, 4), (13, 4), (3, 14), (13, 14))
    for x, y in rays:
        d.line([(8, 9), (x, y)], fill=GOLD2, width=1)
    d.ellipse([4, 5, 12, 13], fill=GOLD)
    d.point((6, 8), fill=INK); d.point((10, 8), fill=INK)
    d.line([(6, 11), (10, 11)], fill=INK)
    return im


def fish(flip):
    im, d = frame(12, 12)
    d.ellipse([1, 4, 8, 9], fill=FISH)
    d.polygon([(8, 6), (11, 3 if not flip else 9), (11, 6)], fill=FISH2)
    d.polygon([(8, 6), (11, 9 if not flip else 3), (11, 6)], fill=FISH2)
    d.point((3, 6), fill=INK)
    d.line([(4, 3 if flip else 4), (6, 2 if flip else 3)], fill=FISH2)
    return im


def ship(bob):
    im, d = frame(24, 18)
    y = 10 + bob
    d.polygon([(2, y), (22, y), (20, y + 5), (4, y + 5)], fill=HULL)
    d.line([(3, y + 1), (21, y + 1)], fill=RED)
    d.rectangle([7, y - 4, 16, y - 1], fill=WHITE)
    d.rectangle([10, y - 8, 12, y - 4], fill=RED)
    for i, (sx, sy) in enumerate(((13, y - 10), (15, y - 12), (17, y - 14))):
        if (i + bob) % 2 == 0: d.ellipse([sx, sy, sx + 2, sy + 2], fill=SMOKE)
    for x in range(1, 23, 4): d.line([(x + (0 if bob else 2), y + 6), (x + 2 + (0 if bob else 2), y + 6)], fill=WATER)
    return im


def hand(push):
    im, d = frame(12, 8)
    x = push
    d.rectangle([x + 1, 3, x + 6, 7], fill=WHITE)        # fist
    d.rectangle([x + 6, 2, x + 10, 3], fill=WHITE)       # index finger
    d.rectangle([x + 2, 1, x + 4, 3], fill=WHITE)        # thumb
    d.point((x + 1, 5), fill=GREY); d.line([(x + 3, 5), (x + 5, 5)], fill=GREY)
    return im


def pad(press):
    im, d = frame(12, 9)
    d.rectangle([1, 2, 10, 6], fill=PAD)
    d.rectangle([0, 3, 11, 5], fill=PAD)
    d.rectangle([0, 6, 2, 7], fill=PAD2); d.rectangle([9, 6, 11, 7], fill=PAD2)
    d.line([(3, 3), (3, 5)], fill=GREY); d.line([(2, 4), (4, 4)], fill=GREY)     # d-pad
    d.point((8, 3), fill=GREY); d.point((9, 4), fill=RED if press else GREY)      # buttons
    d.point((7, 4), fill=GREY); d.point((8, 5), fill=GREY)
    return im


os.makedirs(OUT, exist_ok=True)
strip('sprite-palm.png', [palm(0), palm(1)], 20, 18)
strip('sprite-sun.png', [sun(0), sun(1)], 16, 18)
strip('sprite-fish.png', [fish(0), fish(1)], 12, 12)
strip('sprite-ship.png', [ship(0), ship(1)], 24, 18)
strip('sprite-hand.png', [hand(0), hand(1)], 12, 8)
strip('sprite-pad.png', [pad(0), pad(1)], 12, 9)
