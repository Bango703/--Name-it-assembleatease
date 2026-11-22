#!/usr/bin/env python3
"""App Store screenshot frames for the iPhone apps (owner, 2026-11-06; v2 2026-11-21).

v1 put each raw screen on the sky-blue brand with one headline. v2 (owner: "make
it feel good like marketing on app store ... use any photos from job you think
will look good"):
  - the first frame is a billboard: a real finished job, the headline, and the
    app's own home screen in a phone
  - each screen frame carries a real job photo of a different service, so the
    set reads as many kinds of work at a glance
  - a work frame shows six more real jobs
  - every frame in English and in Spanish

Photos come from images/real-* (already public on the website), never stock and
never a person. Each photo appears once in a set.

    python3 scripts/app-store-frames.py --raw DIR --out DIR [--captions FILE] [--lang en|es|all]

DIR/<lang>/<name>.png are the raw screens (DIR/<name>.png is read as English).
Writes OUT/<lang>/NN-<name>.png at 1320 x 2868, the 6.9-inch size Apple asks for.
Run by the screenshot workflows in codemagic.yaml. Needs Pillow.
"""
import argparse
import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

WIDTH, HEIGHT = 1320, 2868
# Brand tokens (assets/css/marketing.css :root): --cyan, --cyan-dark, --ink.
SKY = (0x00, 0xBF, 0xFF)
SKY_DARK = (0x00, 0x99, 0xCC)
INK = (0x0D, 0x11, 0x17)
WHITE = (255, 255, 255)

# The iPhone's own typeface on the Codemagic Mac; Segoe UI or Arial for a
# preview on Windows. The first that exists is used.
BOLD_FONTS = [
    '/System/Library/Fonts/SFNS.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    'C:/Windows/Fonts/segoeuib.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]
REGULAR_FONTS = [
    '/System/Library/Fonts/SFNS.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    'C:/Windows/Fonts/segoeui.ttf',
    'C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]

HEADLINE_SIZE = 108
SUBLINE_SIZE = 56
SIDE_MARGIN = 100
TOP_MARGIN = 190
PHONE_WIDTH = 1010
BEZEL = 18
CORNER = 96
REPO = pathlib.Path(__file__).resolve().parent.parent


def font(candidates, size, bold):
    for path in candidates:
        if pathlib.Path(path).exists():
            loaded = ImageFont.truetype(path, size)
            if path.endswith('SFNS.ttf'):
                # SF is a variable font: pick the weight by name.
                try:
                    loaded.set_variation_by_name('Bold' if bold else 'Regular')
                except Exception:
                    pass
            return loaded
    sys.exit('No usable font found: ' + ', '.join(candidates))


def wrap(draw, text, face, max_width):
    lines, line = [], ''
    for word in text.split():
        trial = (line + ' ' + word).strip()
        if draw.textlength(trial, font=face) <= max_width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def gradient(size, top, bottom):
    a = Image.new('RGB', size, top)
    b = Image.new('RGB', size, bottom)
    ramp = Image.linear_gradient('L').resize(size)
    return Image.composite(b, a, ramp)


def rounded_mask(size, radius):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def cover(path, size, focus_y=0.5):
    """The photo filling `size`, cropped around a vertical focus point."""
    photo = ImageOps.exif_transpose(Image.open(REPO / path)).convert('RGB')
    scale = max(size[0] / photo.width, size[1] / photo.height)
    resized = photo.resize((round(photo.width * scale), round(photo.height * scale)), Image.LANCZOS)
    left = (resized.width - size[0]) // 2
    top = int((resized.height - size[1]) * focus_y)
    return resized.crop((left, top, left + size[0], top + size[1]))


def shadow_under(canvas, box, radius, strength=120, blur=40, offset=34):
    shadow = Image.new('L', canvas.size, 0)
    x0, y0, x1, y1 = box
    ImageDraw.Draw(shadow).rounded_rectangle((x0 + 10, y0 + offset, x1 - 10, y1 + offset), radius=radius, fill=strength)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    return Image.composite(Image.new('RGB', canvas.size, INK), canvas, shadow)


def write_words(draw, y, headline, subline, bold, regular, color):
    for line in wrap(draw, headline, bold, WIDTH - 2 * SIDE_MARGIN):
        draw.text((WIDTH / 2, y), line, font=bold, fill=color, anchor='mt')
        y += int(HEADLINE_SIZE * 1.16)
    if subline:
        y += 26
        for line in wrap(draw, subline, regular, WIDTH - 2 * SIDE_MARGIN):
            draw.text((WIDTH / 2, y), line, font=regular, fill=color, anchor='mt')
            y += int(SUBLINE_SIZE * 1.3)
    return y


def place_phone(canvas, raw_path, phone_y, phone_width=PHONE_WIDTH):
    screen = Image.open(raw_path).convert('RGB')
    scale = phone_width / PHONE_WIDTH
    bezel, corner = round(BEZEL * scale), round(CORNER * scale)
    inner_w = phone_width - 2 * bezel
    inner_h = round(screen.height * inner_w / screen.width)
    screen = screen.resize((inner_w, inner_h), Image.LANCZOS)
    phone_h = inner_h + 2 * bezel
    phone_x = (WIDTH - phone_width) // 2
    canvas = shadow_under(canvas, (phone_x, phone_y, phone_x + phone_width, phone_y + phone_h), corner)
    body = Image.new('RGB', (phone_width, phone_h), INK)
    body.paste(screen, (bezel, bezel), rounded_mask(screen.size, corner - bezel))
    canvas.paste(body, (phone_x, phone_y), rounded_mask(body.size, corner))
    return canvas, (phone_x, phone_y, phone_x + phone_width, phone_y + phone_h)


def photo_card(canvas, path, center, side=470, angle=-5, border=16, focus_y=0.5):
    """A real job photo as a white-bordered card, slightly turned."""
    inner = cover(path, (side - 2 * border, side - 2 * border), focus_y)
    card = Image.new('RGB', (side, side), WHITE)
    card.paste(inner, (border, border), rounded_mask(inner.size, 30))
    card = card.convert('RGBA')
    card.putalpha(rounded_mask(card.size, 44))
    turned = card.rotate(angle, resample=Image.BICUBIC, expand=True)
    x, y = center[0] - turned.width // 2, center[1] - turned.height // 2
    shadow = Image.new('L', canvas.size, 0)
    shadow.paste(turned.getchannel('A').point(lambda v: 110 if v > 0 else 0), (x + 8, y + 26))
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    canvas = Image.composite(Image.new('RGB', canvas.size, INK), canvas, shadow)
    canvas.paste(turned, (x, y), turned)
    return canvas


def screen_frame(raw_path, words, spec, bold, regular):
    canvas = gradient((WIDTH, HEIGHT), SKY, SKY_DARK)
    draw = ImageDraw.Draw(canvas)
    y = write_words(draw, TOP_MARGIN, words['headline'], words.get('subline', ''), bold, regular, INK)
    canvas, phone = place_phone(canvas, raw_path, y + 170, phone_width=960)
    if spec.get('photo'):
        # Below the words, over the phone's top corner, where screens keep their title bar.
        canvas = photo_card(canvas, spec['photo'], (phone[2] - 60, phone[1] + 200), side=430, focus_y=spec.get('focus', 0.5))
    return canvas


def billboard_frame(raw_path, words, spec, bold, regular):
    base = gradient((WIDTH, HEIGHT), SKY, SKY_DARK)
    canvas = base.copy()
    photo_h = 1500
    photo = cover(spec['photo'], (WIDTH, photo_h), spec.get('focus', 0.35))
    # Darken the top for white words, and fade the bottom into the brand colour.
    shade = Image.linear_gradient('L').resize((WIDTH, photo_h)).point(lambda v: max(0, int(205 - v * 1.15)))
    photo = Image.composite(Image.new('RGB', photo.size, INK), photo, shade)
    canvas.paste(photo, (0, 0))
    fade_h = 420
    fade = Image.linear_gradient('L').resize((WIDTH, fade_h))
    band = canvas.crop((0, photo_h - fade_h, WIDTH, photo_h))
    under = base.crop((0, photo_h - fade_h, WIDTH, photo_h))
    canvas.paste(Image.composite(under, band, fade), (0, photo_h - fade_h))
    # A soft shadow behind the white words keeps them readable on any photo.
    halo = Image.new('L', canvas.size, 0)
    write_words(ImageDraw.Draw(halo), TOP_MARGIN - 40, words['headline'], words.get('subline', ''), bold, regular, 170)
    halo = halo.filter(ImageFilter.GaussianBlur(14))
    canvas = Image.composite(Image.new('RGB', canvas.size, INK), canvas, halo)
    draw = ImageDraw.Draw(canvas)
    write_words(draw, TOP_MARGIN - 40, words['headline'], words.get('subline', ''), bold, regular, WHITE)
    canvas, _ = place_phone(canvas, raw_path, 1180, phone_width=900)
    return canvas


def work_frame(words, spec, bold, regular):
    canvas = gradient((WIDTH, HEIGHT), SKY, SKY_DARK)
    draw = ImageDraw.Draw(canvas)
    y = write_words(draw, TOP_MARGIN, words['headline'], words.get('subline', ''), bold, regular, INK)
    photos = spec['photos']
    cols, gap, side = 2, 36, 80
    tile_w = (WIDTH - 2 * side - gap) // cols
    rows = (len(photos) + cols - 1) // cols
    top = y + 120
    tile_h = min(round(tile_w * 1.12), (HEIGHT - top - 120 - gap * (rows - 1)) // rows)
    for i, path in enumerate(photos):
        col, row = i % cols, i // cols
        x = side + col * (tile_w + gap)
        ty = top + row * (tile_h + gap)
        canvas = shadow_under(canvas, (x, ty, x + tile_w, ty + tile_h), 40, strength=90, blur=24, offset=16)
        tile = cover(path, (tile_w, tile_h))
        canvas.paste(tile, (x, ty), rounded_mask(tile.size, 40))
    return canvas


def photos_in(spec):
    out = []
    for frame in spec['frames'].values():
        if frame.get('photo'):
            out.append(frame['photo'])
        out.extend(frame.get('photos', []))
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--raw', required=True, help='folder of raw screens: <lang>/<name>.png')
    parser.add_argument('--out', required=True, help='folder for the framed screens')
    parser.add_argument('--captions', default=str(REPO / 'mobile/ios/Customer/UITests/store-captions.json'))
    parser.add_argument('--lang', default='all', choices=['en', 'es', 'all'])
    args = parser.parse_args()

    spec = json.loads(pathlib.Path(args.captions).read_text(encoding='utf-8'))
    used = photos_in(spec)
    if len(used) != len(set(used)):
        sys.exit('A photo is used twice in this set.')
    raw, out = pathlib.Path(args.raw), pathlib.Path(args.out)
    bold = font(BOLD_FONTS, HEADLINE_SIZE, True)
    regular = font(REGULAR_FONTS, SUBLINE_SIZE, False)
    langs = ['en', 'es'] if args.lang == 'all' else [args.lang]

    made, missing = 0, []
    for lang in langs:
        (out / lang).mkdir(parents=True, exist_ok=True)
        for position, name in enumerate(spec['order'], start=1):
            frame_spec = spec['frames'][name]
            words = frame_spec[lang]
            layout = frame_spec.get('layout', 'screen')
            if layout == 'work':
                image = work_frame(words, frame_spec, bold, regular)
            else:
                source = raw / lang / (name + '.png')
                if not source.exists() and lang == 'en':
                    source = raw / (name + '.png')
                if not source.exists():
                    missing.append(f'{lang}/{name}')
                    continue
                build = billboard_frame if layout == 'billboard' else screen_frame
                image = build(source, words, frame_spec, bold, regular)
            target = out / lang / f'{position:02d}-{name}.png'
            image.save(target, 'PNG')
            made += 1
            print(f'{lang}/{target.name}: {words["headline"]}')
    if missing:
        print('Not captured, so not framed: ' + ', '.join(missing))
    if made == 0:
        sys.exit('No screens were framed.')


if __name__ == '__main__':
    main()
