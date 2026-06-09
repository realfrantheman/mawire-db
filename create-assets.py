#!/usr/bin/env python3
"""Generate icon-192.png, icon-512.png, og-image.png for mergers.news"""

from PIL import Image, ImageDraw, ImageFont
import math

FONT_BOLD   = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

# Brand colours
BG      = (10, 10, 20)       # near-black navy
GOLD    = (212, 175, 55)     # gold
WHITE   = (255, 255, 255)
SILVER  = (180, 180, 200)
ACCENT  = (212, 175, 55)


def draw_rounded_rect(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.ellipse([x0, y0, x0 + radius*2, y0 + radius*2], fill=fill)
    draw.ellipse([x1 - radius*2, y0, x1, y0 + radius*2], fill=fill)
    draw.ellipse([x0, y1 - radius*2, x0 + radius*2, y1], fill=fill)
    draw.ellipse([x1 - radius*2, y1 - radius*2, x1, y1], fill=fill)


def make_icon(size):
    img  = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(size * 0.04)
    draw_rounded_rect(draw, [pad, pad, size - pad, size - pad],
                      radius=int(size * 0.18), fill=BG)

    # Gold bar accent top-left
    bar_h = max(3, int(size * 0.025))
    bar_w = int(size * 0.35)
    bx = int(size * 0.18)
    by = int(size * 0.22)
    draw.rectangle([bx, by, bx + bar_w, by + bar_h], fill=GOLD)

    # Large "M" lettermark
    font_size = int(size * 0.52)
    try:
        font = ImageFont.truetype(FONT_BOLD, font_size)
    except Exception:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), 'M', font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = (size - th) // 2 - bbox[1] + int(size * 0.04)
    draw.text((tx, ty), 'M', font=font, fill=WHITE)

    # Small ".news" tag below
    tag_size = max(10, int(size * 0.115))
    try:
        tag_font = ImageFont.truetype(FONT_REGULAR, tag_size)
    except Exception:
        tag_font = ImageFont.load_default()

    tag = '.news'
    tbbox = draw.textbbox((0, 0), tag, font=tag_font)
    ttw = tbbox[2] - tbbox[0]
    ttx = (size - ttw) // 2 - tbbox[0]
    tty = ty + th + int(size * 0.01)
    draw.text((ttx, tty), tag, font=tag_font, fill=GOLD)

    return img


def make_og():
    W, H = 1200, 630
    img  = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Subtle gradient overlay — horizontal bands
    for y in range(H):
        alpha = int(18 * (1 - y / H))
        draw.line([(0, y), (W, y)], fill=(30, 30, 55))

    # Gold accent bar left edge
    draw.rectangle([0, 0, 6, H], fill=GOLD)

    # Top-right decorative grid dots
    for gx in range(820, 1180, 40):
        for gy in range(40, 260, 40):
            r = 2
            draw.ellipse([gx - r, gy - r, gx + r, gy + r], fill=(40, 40, 70))

    # "mergers" in large white
    try:
        title_font = ImageFont.truetype(FONT_BOLD, 110)
    except Exception:
        title_font = ImageFont.load_default()

    draw.text((80, 140), 'mergers', font=title_font, fill=WHITE)

    # ".news" in gold, right-aligned to title
    try:
        dot_font = ImageFont.truetype(FONT_BOLD, 110)
    except Exception:
        dot_font = ImageFont.load_default()

    m_bbox = draw.textbbox((0, 0), 'mergers', font=title_font)
    m_w    = m_bbox[2] - m_bbox[0]
    draw.text((80 + m_w, 140), '.news', font=dot_font, fill=GOLD)

    # Tagline
    try:
        tag_font = ImageFont.truetype(FONT_REGULAR, 36)
    except Exception:
        tag_font = ImageFont.load_default()

    draw.text((82, 285), 'Global M&A Intelligence — 10,000+ Deals Tracked',
              font=tag_font, fill=SILVER)

    # Divider line
    draw.rectangle([80, 345, 520, 348], fill=GOLD)

    # Stats row
    try:
        stat_font  = ImageFont.truetype(FONT_BOLD, 42)
        label_font = ImageFont.truetype(FONT_REGULAR, 22)
    except Exception:
        stat_font  = ImageFont.load_default()
        label_font = ImageFont.load_default()

    stats = [
        ('SEC EDGAR', 'Filings'),
        ('EU Registry', 'Mergers'),
        ('HKEX · ASX · SGX', 'APAC Deals'),
    ]
    sx = 80
    for val, lbl in stats:
        draw.text((sx, 375), val,  font=stat_font,  fill=WHITE)
        vbbox = draw.textbbox((0, 0), val, font=stat_font)
        draw.text((sx, 425), lbl,  font=label_font, fill=SILVER)
        sx += vbbox[2] - vbbox[0] + 60

    # Bottom domain
    try:
        url_font = ImageFont.truetype(FONT_REGULAR, 26)
    except Exception:
        url_font = ImageFont.load_default()

    draw.text((82, 565), 'mergers.news', font=url_font, fill=GOLD)

    return img


print('Generating icon-192.png ...')
make_icon(192).save('/home/user/mawire-db/icon-192.png', 'PNG')

print('Generating icon-512.png ...')
make_icon(512).save('/home/user/mawire-db/icon-512.png', 'PNG')

print('Generating og-image.png ...')
make_og().save('/home/user/mawire-db/og-image.png', 'PNG')

print('Done. Files written to /home/user/mawire-db/')
