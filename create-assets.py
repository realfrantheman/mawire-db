#!/usr/bin/env python3
"""Generate icon-192.png, icon-512.png, og-image.png using real brand assets."""

from PIL import Image, ImageDraw, ImageFont

LOGO_PATH   = '/root/.claude/uploads/5a179ff7-cf74-54c1-84e3-c32c56b74cf0/d1f8a57d-logo240.png'
BANNER_PATH = '/root/.claude/uploads/5a179ff7-cf74-54c1-84e3-c32c56b74cf0/2c258c9c-Screen_Shot_20260603_at_10.29.25_PM.png'

FONT_BOLD    = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

BG     = (10, 10, 12)
RED    = (200, 20, 30)
WHITE  = (255, 255, 255)
SILVER = (180, 180, 190)

logo   = Image.open(LOGO_PATH).convert('RGBA')
banner = Image.open(BANNER_PATH).convert('RGBA')

# ── Icons: resize logo square to target size ──────────────────────
for size, filename in [(192, 'icon-192.png'), (512, 'icon-512.png')]:
    icon = logo.resize((size, size), Image.LANCZOS)
    # Flatten onto black background (removes any transparency fringing)
    bg = Image.new('RGBA', (size, size), (10, 10, 12, 255))
    bg.paste(icon, (0, 0), icon)
    bg.convert('RGB').save(f'/home/user/mawire-db/{filename}', 'PNG')
    print(f'Wrote {filename} ({size}x{size})')

# ── OG image 1200x630 ─────────────────────────────────────────────
W, H = 1200, 630
og = Image.new('RGB', (W, H), BG)
draw = ImageDraw.Draw(og)

# Subtle top highlight band
for y in range(3):
    draw.line([(0, y), (W, y)], fill=(35, 35, 40))

# Left red accent bar
draw.rectangle([0, 0, 5, H], fill=RED)

# Paste logo (scaled to ~260px) on the right side
logo_size = 260
logo_og = logo.resize((logo_size, logo_size), Image.LANCZOS)
logo_bg = Image.new('RGBA', (logo_size, logo_size), (*BG, 255))
logo_bg.paste(logo_og, (0, 0), logo_og)
og.paste(logo_bg.convert('RGB'), (W - logo_size - 80, (H - logo_size) // 2))

# Light vertical divider before logo
div_x = W - logo_size - 110
draw.rectangle([div_x, 80, div_x + 1, H - 80], fill=(40, 40, 48))

# "MERGERS" large white text
try:
    big = ImageFont.truetype(FONT_BOLD, 108)
except Exception:
    big = ImageFont.load_default()

draw.text((80, 120), 'MERGERS', font=big, fill=WHITE)

# ".NEWS" in red, same baseline
m_bbox = draw.textbbox((0, 0), 'MERGERS', font=big)
draw.text((80 + m_bbox[2] - m_bbox[0], 120), '.NEWS', font=big, fill=RED)

# Red underline
try:
    tag_font = ImageFont.truetype(FONT_REGULAR, 30)
except Exception:
    tag_font = ImageFont.load_default()

full_bbox = draw.textbbox((0, 0), 'MERGERS.NEWS', font=big)
underline_w = full_bbox[2] - full_bbox[0]
draw.rectangle([80, 248, 80 + underline_w, 252], fill=RED)

# Tagline
draw.text((82, 272), 'Global M&A Intelligence', font=tag_font, fill=SILVER)

# Stats row
try:
    stat_bold  = ImageFont.truetype(FONT_BOLD, 36)
    stat_light = ImageFont.truetype(FONT_REGULAR, 22)
except Exception:
    stat_bold  = ImageFont.load_default()
    stat_light = ImageFont.load_default()

stats = [
    ('10,000+', 'Deals tracked'),
    ('SEC · EU · APAC', 'Live sources'),
    ('Since 1993', 'Historical data'),
]
sx = 80
for val, lbl in stats:
    draw.text((sx, 360), val, font=stat_bold,  fill=WHITE)
    vb = draw.textbbox((0, 0), val, font=stat_bold)
    draw.text((sx, 405), lbl, font=stat_light, fill=SILVER)
    sx += (vb[2] - vb[0]) + 55

# Bottom rule + domain
draw.rectangle([80, 530, div_x - 20, 531], fill=(40, 40, 48))
try:
    url_font = ImageFont.truetype(FONT_REGULAR, 24)
except Exception:
    url_font = ImageFont.load_default()
draw.text((82, 548), 'mergers.news', font=url_font, fill=RED)

og.save('/home/user/mawire-db/og-image.png', 'PNG')
print('Wrote og-image.png (1200x630)')
