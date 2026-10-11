"""Measure a pack's props on one tile grid: footprints, drawn sizes, and a size sheet to eyeball them.

    python tools/forge/measure.py my-world          # table + forge-raw/my-world/sizes.png
    python tools/forge/measure.py my-world --fill   # give props without a `foot` a proposed one (writes pack.json)
    python tools/forge/measure.py my-world --tile 2 # as they'd look on a layer with 2x tiles

A prop's `foot` is its width in tiles at tile size 1 (roughly: one tile = one house lot). The map rounds it
to an n x n footprint (max 4x4); smaller things keep one cell and are drawn narrower. Images carry no real
scale, so `foot` is a judgement: this proposes one from the prop's base and name, and the sheet shows every
prop standing on its footprint at the same scale so outliers jump out. Fine-tune in the app (Place tool:
the - / + on the size bar saves straight into pack.json).
"""
import argparse
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
TW, TH, MAX_FOOT = 64, 32, 4

# typical widths, in tiles, of the built-in kinds a pack prop can extend
BASE_FOOT = {
    "castle": 2, "skyscraper": 1.5, "tower": 1, "house": 1, "apartment": 1, "shop": 1, "ruins": 1,
    "tree": 1, "pine": 0.7, "palm": 0.8, "cactus": 0.5, "mushroom": 1, "boulder": 0.8, "crystals": 0.8,
    "chest": 0.6, "torch": 0.5, "campfire": 0.6, "boat": 1, "car": 0.5,
}
WORDS = [  # (pattern, multiplier or absolute "=n")
    (r"\b(palace|citadel|fortress|cathedral|basilica|colossus|behemoth|ziggurat)\b", "=3"),
    (r"\b(temple|castle|manor|hold|keep|mansion|gallery|hall|monastery|tower block)\b", 1.5),
    (r"\b(huge|giant|colossal|massive|vast|enormous|great|grand|sprawling)\b", 1.5),
    (r"\b(small|tiny|little|lone|single|slender|thin)\b", 0.7),
    (r"\b(lamp|lantern|candle|candelabra|post|sign|statue|stone|shrub|bush|flower|crate|barrel)\b", 0.6),
]


def propose(prop: dict) -> float:
    f = BASE_FOOT.get(prop.get("base", ""), 1.0)
    text = f"{prop.get('name', '')} {prop.get('prompt', '')}".lower()
    for pat, k in WORDS:
        if re.search(pat, text):
            f = float(k[1:]) if isinstance(k, str) else f * k
    steps = [0.25, 0.4, 0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]
    return min(steps, key=lambda s: abs(s - f))


def dump_pack(pack: dict) -> str:
    """pack.json text: 2-space JSON with [x, y] sizes kept on one line."""
    return re.sub(r"\[\s*([\d.]+),\s*([\d.]+)\s*\]", r"[\1, \2]", json.dumps(pack, indent=2, ensure_ascii=False)) + "\n"


def fill_missing(pack_path: Path) -> int:
    """Gives every prop without a `foot` the proposed one. Returns how many were filled."""
    pack = json.loads(pack_path.read_text())
    missing = [p for p in pack["props"] if "foot" not in p]
    for p in missing:
        p["foot"] = propose(p)
        print(f"  {p['id']}: size {p['foot']} (proposed — check it with measure.py)")
    if missing:
        pack_path.write_text(dump_pack(pack))
    return len(missing)


def size_on(foot, tile: float):
    """(nx, ny, drawn width) — the same rule as src/core/footprint.ts."""
    a, b = foot if isinstance(foot, list) else (foot, foot)
    fa, fb = a / tile, b / tile
    nx, ny = (max(1, min(MAX_FOOT, int(f + 0.5))) for f in (fa, fb))  # round half up, like the app
    return nx, ny, max(0.3, min((nx + ny) / 2, (fa + fb) / 2))


def foot_str(foot):
    return f"{foot[0]}x{foot[1]}" if isinstance(foot, list) else str(foot)


def diamond(draw, cx, cy, w, h, fill, outline):
    draw.polygon([(cx, cy - h / 2), (cx + w / 2, cy), (cx, cy + h / 2), (cx - w / 2, cy)], fill=fill, outline=outline)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pack")
    ap.add_argument("--fill", action="store_true", help="write proposed sizes for props that have none")
    ap.add_argument("--tile", type=float, default=1.0, help="tile size to measure at (default 1)")
    args = ap.parse_args()

    pack_path = ROOT / "src/packs" / args.pack / "pack.json"
    pack = json.loads(pack_path.read_text())
    out = ROOT / "public/packs" / args.pack
    manifest = json.loads((out / "assets.json").read_text()) if (out / "assets.json").exists() else {"props": {}}

    if args.fill and fill_missing(pack_path):
        pack = json.loads(pack_path.read_text())
    rows = []
    for p in pack["props"]:
        foot = p.get("foot", propose(p))
        nx, ny, w = size_on(foot, args.tile)
        art = manifest["props"].get(p["id"])
        img = Image.open(out / art["src"]).convert("RGBA") if art and (out / art["src"]).exists() else None
        tall = (img.height / img.width) * w * 0.92 if img else 0  # drawn height, in tile widths
        rows.append((p, foot, nx, ny, w, img, art, tall))

    print(f"{'prop':20} {'foot':>7} {'cells':>6} {'drawn':>6} {'tall':>5}  note")
    for p, foot, nx, ny, w, img, art, tall in sorted(rows, key=lambda r: -r[2] * r[3]):
        note = "no art yet" if img is None else "very tall for its footprint" if tall > 2.5 * (nx + ny) / 2 else ""
        if "foot" not in p:
            note = (note + "; " if note else "") + f"no foot set (proposed {foot})"
        print(f"{p['id']:20} {foot_str(foot):>7} {nx:>4}x{ny} {w:>6.2f} {tall:>5.1f}  {note}")

    # size sheet: every prop on its footprint, one shared scale, biggest first
    S = 1.0  # pixels per map pixel
    items = sorted(rows, key=lambda r: (-r[2] * r[3], -r[4]))
    pad, label_h, max_w = 18, 30, 1700
    placed, x, y, row_h = [], pad, pad, 0
    for p, foot, nx, ny, w, img, art, tall in items:
        span = (nx + ny) / 2
        cw = span * TW * S
        dw = w * TW * 0.92 * S
        dh = dw * img.height / img.width if img else 0
        above = max(dh * (art["ay"] if art else 1), span * TH * S / 2)
        ch = above + span * TH * S / 2 + label_h
        if x + cw + pad > max_w:
            x, y, row_h = pad, y + row_h + pad, 0
        placed.append((x, y, cw, ch, above, p, foot, nx, ny, w, img, art, dw, dh))
        x += cw + pad
        row_h = max(row_h, ch)
    sheet = Image.new("RGB", (max_w, int(y + row_h + pad)), (38, 36, 46))
    draw = ImageDraw.Draw(sheet)
    for x, y, cw, ch, above, p, foot, nx, ny, w, img, art, dw, dh in placed:
        cx, cy = x + cw / 2, y + above  # footprint centre
        for j in range(ny):
            for i in range(nx):
                # cell (i, j) of the footprint relative to its centre (x runs down-right, y down-left)
                a, b = i - (nx - 1) / 2, j - (ny - 1) / 2
                diamond(draw, cx + (a - b) * TW * S / 2, cy + (a + b) * TH * S / 2, TW * S, TH * S, (70, 66, 84), (120, 114, 140))
        if img:
            sprite = img.resize((max(1, round(dw)), max(1, round(dh))), Image.LANCZOS)
            long = isinstance(foot, list) and foot[0] != foot[1]  # same rule as the painted skin
            ax, ay = (0.5, 1 - 0.225 * img.width / img.height) if long else (art["ax"], art["ay"])
            sheet.paste(sprite, (round(cx - ax * dw), round(cy - ay * dh)), sprite)
        draw.text((x, y + ch - label_h + 4), f"{p['id'][:18]}", fill=(230, 228, 240))
        draw.text((x, y + ch - label_h + 16), f"{foot_str(foot)} -> {nx}x{ny}", fill=(170, 165, 190))
    dest = ROOT / "forge-raw" / args.pack / "sizes.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dest)
    print(dest)


if __name__ == "__main__":
    sys.exit(main())
