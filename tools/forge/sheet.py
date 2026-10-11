"""Contact sheet of a pack's forged art, for reviewing a batch at a glance.

    python tools/forge/sheet.py my-world props     # → forge-raw/my-world/sheet-props.png
    python tools/forge/sheet.py my-world terrain
    python tools/forge/sheet.py my-world views     # each prop as the map turns: 0°, 90°, 180°, 270°
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]


def views_sheet(pack):
    folder = ROOT / "public/packs" / pack / "props"
    mains = sorted(f for f in folder.glob("*.png") if ".v" not in f.stem)
    cell, per_row = 150, 3  # three props (four views each) per row
    rows = (len(mains) + per_row - 1) // per_row
    sheet = Image.new("RGB", (per_row * (4 * cell + 24), rows * (cell + 16)), (46, 44, 52))
    draw = ImageDraw.Draw(sheet)
    for i, f in enumerate(mains):
        ox, oy = (i % per_row) * (4 * cell + 24), (i // per_row) * (cell + 16)
        for v in range(4):
            p = f if v == 0 else folder / f"{f.stem}.v{v}.png"
            if not p.exists():
                continue
            im = Image.open(p).convert("RGBA")
            im.thumbnail((cell - 8, cell - 8))
            sheet.paste(im, (ox + v * cell + (cell - im.width) // 2, oy + (cell - im.height) // 2), im)
        draw.text((ox + 4, oy + cell + 2), f.stem[:26], fill=(225, 225, 230))
    out = ROOT / "forge-raw" / pack / "sheet-views.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(out)


def main():
    pack, kind = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "props")
    if kind.startswith("view"):
        return views_sheet(pack)
    folder = ROOT / "public/packs" / pack / ("props" if kind.startswith("prop") else "terrain" if kind.startswith("terr") else "sides")
    files = sorted(f for f in folder.glob("*.png") if ".v" not in f.stem)  # turned views: see views.py
    cols, cell = 8, 180
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 16)), (46, 44, 52))
    draw = ImageDraw.Draw(sheet)
    for i, f in enumerate(files):
        im = Image.open(f).convert("RGBA")
        im.thumbnail((cell - 8, cell - 8))
        x, y = (i % cols) * cell, (i // cols) * (cell + 16)
        sheet.paste(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2), im)
        draw.text((x + 4, y + cell + 2), f.stem[:26], fill=(225, 225, 230))
    out = ROOT / "forge-raw" / pack / f"sheet-{folder.name}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(out)


if __name__ == "__main__":
    main()
