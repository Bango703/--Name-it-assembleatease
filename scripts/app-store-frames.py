#!/usr/bin/env python3
"""App Store screenshot frames for the customer app (owner, 2026-11-06).

The listing showed three bare simulator screens with no headline; TaskRabbit
shows five or more, each with one line on its brand colour. This puts each raw
screen from StoreScreenshots.swift on the sky-blue brand with its headline from
mobile/ios/Customer/UITests/store-captions.json, at the 6.9-inch size Apple
asks for (1320 x 2868), in the order the App Store should show them.

    python3 scripts/app-store-frames.py --raw DIR --out DIR [--captions FILE]

Run by the customer-screenshots workflow in codemagic.yaml. Needs Pillow.
"""
import argparse
import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

WIDTH, HEIGHT = 1320, 2868
# Brand tokens (assets/css/marketing.css :root): --cyan, --cyan-dark, --ink.
SKY = (0x00, 0xBF, 0xFF)
SKY_DARK = (0x00, 0x99, 0xCC)
INK = (0x0D, 0x11, 0x17)

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


def background():
    top = Image.new('RGB', (WIDTH, HEIGHT), SKY)
    bottom = Image.new('RGB', (WIDTH, HEIGHT), SKY_DARK)
    ramp = Image.linear_gradient('L').resize((WIDTH, HEIGHT))
    return Image.composite(bottom, top, ramp)


def rounded_mask(size, radius):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def frame(raw_path, headline, subline, bold, regular):
    canvas = background()
    draw = ImageDraw.Draw(canvas)

    y = TOP_MARGIN
    for line in wrap(draw, headline, bold, WIDTH - 2 * SIDE_MARGIN):
        draw.text((WIDTH / 2, y), line, font=bold, fill=INK, anchor='mt')
        y += int(HEADLINE_SIZE * 1.16)
    if subline:
        y += 26
        for line in wrap(draw, subline, regular, WIDTH - 2 * SIDE_MARGIN):
            draw.text((WIDTH / 2, y), line, font=regular, fill=INK, anchor='mt')
            y += int(SUBLINE_SIZE * 1.3)

    screen = Image.open(raw_path).convert('RGB')
    inner_w = PHONE_WIDTH - 2 * BEZEL
    inner_h = round(screen.height * inner_w / screen.width)
    screen = screen.resize((inner_w, inner_h), Image.LANCZOS)
    phone_h = inner_h + 2 * BEZEL
    phone_x = (WIDTH - PHONE_WIDTH) // 2
    phone_y = y + 90  # straight under the words; a tall screen runs off the bottom edge

    shadow = Image.new('L', (WIDTH, HEIGHT), 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        (phone_x + 10, phone_y + 34, phone_x + PHONE_WIDTH - 10, phone_y + phone_h + 34), radius=CORNER, fill=120)
    shadow = shadow.filter(ImageFilter.GaussianBlur(40))
    canvas = Image.composite(Image.new('RGB', (WIDTH, HEIGHT), INK), canvas, shadow)

    body = Image.new('RGB', (PHONE_WIDTH, phone_h), INK)
    body.paste(screen, (BEZEL, BEZEL), rounded_mask(screen.size, CORNER - BEZEL))
    canvas.paste(body, (phone_x, phone_y), rounded_mask(body.size, CORNER))
    return canvas


def main():
    here = pathlib.Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument('--raw', required=True, help='folder of raw screens, named as in the captions file')
    parser.add_argument('--out', required=True, help='folder for the framed screens')
    parser.add_argument('--captions', default=str(here / 'mobile/ios/Customer/UITests/store-captions.json'))
    args = parser.parse_args()

    spec = json.loads(pathlib.Path(args.captions).read_text(encoding='utf-8'))
    raw, out = pathlib.Path(args.raw), pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    bold = font(BOLD_FONTS, HEADLINE_SIZE, True)
    regular = font(REGULAR_FONTS, SUBLINE_SIZE, False)

    made, missing = 0, []
    for position, name in enumerate(spec['order'], start=1):
        caption = spec['captions'][name]
        source = raw / (name + '.png')
        if not source.exists():
            missing.append(name)
            continue
        image = frame(source, caption['headline'], caption.get('subline', ''), bold, regular)
        target = out / f'{position:02d}-{name}.png'
        image.save(target, 'PNG')
        made += 1
        print(f'{target.name}: {caption["headline"]}')
    if missing:
        print('Not captured, so not framed: ' + ', '.join(missing))
    if made == 0:
        sys.exit('No screens were framed.')


if __name__ == '__main__':
    main()
