"""Forge painted art for a world pack with a local ComfyUI.

    python tools/forge/forge.py my-world                 # everything that's missing
    python tools/forge/forge.py my-world --only tower,moss --force --seed 7
    python tools/forge/forge.py my-world --views          # turn each prop: 90°, 180°, 270° views (Qwen Image Edit)
    python tools/forge/forge.py my-world --views --fix    # redo views that came out tipped over or squashed

A view set to false in assets.json ("views": [false, {...}, false]) is left to the app's mirrored stand-in.

Reads src/packs/<pack>/pack.json, writes images and assets.json into public/packs/<pack>/
(full-size raw generations go to forge-raw/<pack>/ so --repost can redo post-processing).
Run it with ComfyUI's Python (it needs numpy, Pillow and scipy) while ComfyUI is running.
"""
import argparse
import io
import json
import math
import sys
import time
import zlib
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import comfy  # noqa: E402
import measure  # noqa: E402
import post  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]

TEXTURE = (
    "Seamless tileable hand-painted game texture, looking straight down at the ground, flat orthographic top-down view, "
    "no perspective, no horizon, no sky, uniform flat even lighting with no light gradient, no vignette, no stripes or bands, "
    "homogeneous detail density across the whole image, small-scale fine detail, the pattern fills the entire frame edge to edge: "
    "{subject}. {style}"
)
SIDE = (
    "Seamless tileable hand-painted game texture of a vertical cliff or wall face seen straight-on, flat orthographic front view, "
    "no perspective, no sky, no ground line, uniform flat even lighting, homogeneous detail, the pattern fills the entire frame "
    "edge to edge: {subject}. {style}"
)
SPRITE = (
    "Isometric game asset: {subject}. A single object viewed from above at a 30 degree isometric angle, the whole object visible "
    "and centered with generous empty space around it, isolated on a flat uniform pure {bg} background, no ground plane, "
    "no cast shadow on the background, no text. {style}"
)


# Views for the rotated map. The app's view v shows the world turned v quarter-turns clockwise on screen,
# which is the camera orbiting to its right around each object.
VIEW = {
    1: "Rotate the camera 90 degrees to the right around the object, orbiting it while keeping the same high isometric "
       "viewing angle and distance. Show the side of the object that was hidden on the right.",
    2: "Rotate the camera 180 degrees around the object to view it from the back, keeping the same high isometric "
       "viewing angle and distance.",
    3: "Rotate the camera 90 degrees to the left around the object, orbiting it while keeping the same high isometric "
       "viewing angle and distance. Show the side of the object that was hidden on the left.",
}
VIEW_KEEP = (
    " The object stays upright, standing on the ground exactly as before. Keep exactly the same object, materials, "
    "colours and painting style, on the same flat uniform pure {bg} background, with no cast shadow."
)


def view_aspect(view: Image.Image, main_path: Path) -> float:
    """How much a turned view's height/width differs from the main sprite's. Far below 1 means the edit tipped
    the object over (a tower lying down); far above 1 means an edge-on sliver."""
    im = view if view.mode == "RGBA" else post.key_sprite(view, drop_shadow=True)[0]
    m = Image.open(main_path)
    return (im.height / im.width) / (m.height / m.width)


VIEW_OK = (0.75, 2.0)


def edit_workflow(image: str, prompt: str, seed: int) -> dict:
    """Qwen Image Edit 2511 + 4-step Lightning: re-draws an uploaded image from an instruction."""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_edit_2511_bf16.safetensors", "weight_dtype": "fp8_e4m3fn"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1.0}},
        "5": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["4", 0], "shift": 3.1}},
        "6": {"class_type": "LoadImage", "inputs": {"image": image}},
        "7": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": prompt, "vae": ["3", 0], "image1": ["6", 0]}},
        "8": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": "", "vae": ["3", 0], "image1": ["6", 0]}},
        "9": {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["7", 0], "reference_latents_method": "index_timestep_zero"}},
        "10": {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["8", 0], "reference_latents_method": "index_timestep_zero"}},
        "11": {"class_type": "VAEEncode", "inputs": {"pixels": ["6", 0], "vae": ["3", 0]}},
        "12": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 4, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1, "model": ["5", 0], "positive": ["9", 0], "negative": ["10", 0], "latent_image": ["11", 0]}},
        "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["3", 0]}},
        "14": {"class_type": "SaveImage", "inputs": {"filename_prefix": "wmb_view", "images": ["13", 0]}},
    }


def workflow(prompt: str, seed: int, w: int = 1024, h: int = 1024, steps: int = 10) -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "krea2_turbo_fp8_scaled.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": steps, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1, "model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "wmb_forge", "images": ["8", 0]}},
    }


def key_color(subject: str) -> str:
    """Magenta keys cleanly unless the subject itself is pink/purple; then use green."""
    s = subject.lower()
    return "green (#00FF00)" if any(w in s for w in ("violet", "purple", "pink", "magenta", "lilac")) else "magenta (#FF00FF)"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pack")
    ap.add_argument("--only", help="comma-separated asset ids (a single view: id@1, id@2, id@3)")
    ap.add_argument("--kind", choices=["sides", "terrains", "props"], help="limit to one kind")
    ap.add_argument("--force", action="store_true", help="regenerate even if the file exists")
    ap.add_argument("--seed", type=int, default=0, help="offset added to every asset's seed (try another look)")
    ap.add_argument("--repost", action="store_true", help="re-run post-processing on kept raw images; no generation")
    ap.add_argument("--views", action="store_true", help="make the 90/180/270-degree views of props (needs their raw images)")
    ap.add_argument("--fix", action="store_true", help="with --views: redo only views that look tipped over or squashed")
    args = ap.parse_args()

    pack = json.loads((ROOT / "src/packs" / args.pack / "pack.json").read_text())
    out = ROOT / "public/packs" / args.pack
    raw_dir = ROOT / "forge-raw" / args.pack  # full-size generations, kept out of the shipped app
    style = pack.get("style", "")
    # textures stay neutral: cinematic colour grading in the style line tints them and breaks tiling
    tex_style = pack.get("textureStyle", "painterly fantasy concept art texture, natural colours, rich fine detail")
    only = set(args.only.split(",")) if args.only else None
    manifest_path = out / "assets.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"terrains": {}, "props": {}}

    jobs = []  # (kind, id, prompt, relpath)
    if args.kind in (None, "sides"):
        for key, subj in pack.get("sides", {}).items():
            jobs.append(("side", key, SIDE.format(subject=subj, style=tex_style), f"sides/{key}.png"))
    if args.kind in (None, "terrains"):
        for t in pack["terrains"]:
            art = t.get("art", {})
            if art.get("top"):
                jobs.append(("top", t["id"], TEXTURE.format(subject=art["top"], style=tex_style), f"terrain/{t['id']}.png"))
            if art.get("sprite"):
                jobs.append(("tsprite", t["id"], SPRITE.format(subject=art["sprite"], style=style, bg=key_color(art["sprite"])), f"terrain/{t['id']}_sprite.png"))
    if args.kind in (None, "props"):
        for p in pack["props"]:
            if p.get("prompt"):
                jobs.append(("prop", p["id"], SPRITE.format(subject=p["prompt"], style=style, bg=key_color(p["prompt"])), f"props/{p['id']}.png"))

    if args.views:
        jobs = []
        for p in pack["props"]:
            if p.get("prompt"):
                bg = key_color(p["prompt"])
                for v, instr in VIEW.items():
                    jobs.append(("view", f"{p['id']}@{v}", instr + VIEW_KEEP.format(bg=bg), f"props/{p['id']}.v{v}.png"))
    if only:
        jobs = [j for j in jobs if j[1] in only or j[1].split("@")[0] in only]  # "temple" or one view: "temple@2"
    if args.repost:
        for kind, aid, _, rel in jobs:
            raw_path = raw_dir / raw_name(kind, aid)
            if raw_path.exists():
                finish(kind, aid, Image.open(raw_path), out, rel, manifest)
        write_manifest(pack, out, manifest, manifest_path)
        print(f"re-posted {len(jobs)} assets")
        return
    if args.views and args.fix:
        def bad(j):
            pid, v = j[1].split("@")
            main = manifest["props"].get(pid)
            if main and (main.get("views") or [None] * 3)[int(v) - 1] is False:
                return False  # deliberately left to the mirrored stand-in
            if not (out / j[3]).exists() or not main:
                return True
            r = view_aspect(Image.open(out / j[3]), out / main["src"])
            return not VIEW_OK[0] <= r <= VIEW_OK[1]
        jobs = [j for j in jobs if bad(j)]
        print("views to fix:", ", ".join(j[1] for j in jobs) or "none")
    elif not args.force:
        jobs = [j for j in jobs if not (out / j[3]).exists()]
    if not comfy.alive():
        sys.exit(f"ComfyUI is not reachable on {comfy.HOST} — start it first (or set COMFY_HOST).")
    print(f"forging {len(jobs)} assets for {pack['name']}", flush=True)

    for n, (kind, aid, prompt, rel) in enumerate(jobs, 1):
        t0 = time.time()
        seed = zlib.crc32(f"{args.pack}/{aid}".encode()) + args.seed
        try:
            if kind == "view":
                pid = aid.split("@")[0]
                src = raw_dir / f"prop_{pid}.png"
                if not src.exists() or pid not in manifest["props"]:
                    raise FileNotFoundError(f"no raw image {src.name} to turn")
                name = comfy.upload_image(str(src), f"wmb_{args.pack}_{src.name}")
                best = None
                for attempt in range(4):  # edits sometimes tip things over: check the shape, retry with new seeds
                    cand = Image.open(io.BytesIO(comfy.run(edit_workflow(name, prompt, seed + attempt * 7919))[0]))
                    r = view_aspect(cand, out / manifest["props"][pid]["src"])
                    if best is None or abs(math.log(r)) < abs(math.log(best[1])):
                        best = (cand, r)
                    if VIEW_OK[0] <= r <= VIEW_OK[1]:
                        break
                    print(f"    {aid}: looks tipped over or squashed (aspect x{r:.2f}), retrying", flush=True)
                raw = best[0]
            else:
                raw = Image.open(io.BytesIO(comfy.run(workflow(prompt, seed))[0]))
            dest = out / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            raw_dir.mkdir(parents=True, exist_ok=True)
            raw.save(raw_dir / raw_name(kind, aid))
            finish(kind, aid, raw, out, rel, manifest)
            print(f"[{n}/{len(jobs)}] {kind:7} {aid:18} {time.time() - t0:5.1f}s", flush=True)
        except Exception as e:  # keep going; one bad asset shouldn't sink the batch
            print(f"[{n}/{len(jobs)}] {kind:7} {aid:18} FAILED: {e}", flush=True)
            continue
        write_manifest(pack, out, manifest, manifest_path)
    write_manifest(pack, out, manifest, manifest_path)
    # new props get a proposed footprint so they arrive at a sensible size (see measure.py)
    measure.fill_missing(ROOT / "src/packs" / args.pack / "pack.json")


def raw_name(kind, aid):
    if kind == "view":
        pid, v = aid.split("@")
        return f"view{v}_{pid}.png"
    return f"{kind}_{aid}.png"


def finish(kind, aid, raw, out, rel, manifest):
    dest = out / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if kind in ("side", "top"):
        post.seamless(raw).save(dest)
        return
    im, ax, ay, w0 = post.key_sprite(raw, drop_shadow=kind == "view")
    im.save(dest)
    if kind == "prop":
        old = manifest["props"].get(aid, {})
        manifest["props"][aid] = {"src": rel, "ax": ax, "ay": ay, "w0": w0, **({"views": old["views"]} if "views" in old else {})}
    elif kind == "view":
        pid, v = aid.split("@")
        entry = manifest["props"].get(pid)
        if entry is None:
            raise KeyError(f"forge the prop {pid} before its views")
        views = (entry.get("views") or [None, None, None])[:3]  # false = keep the mirrored stand-in
        views[int(v) - 1] = {"src": rel, "ax": ax, "ay": ay, "w0": w0}
        entry["views"] = views


def write_manifest(pack, out, manifest, path):
    """Terrain entries are rebuilt from whatever files exist, so partial runs are always usable."""
    terrains = {}
    for t in pack["terrains"]:
        art, e = t.get("art", {}), {}
        if (out / f"terrain/{t['id']}.png").exists():
            e["top"] = f"terrain/{t['id']}.png"
        if art.get("side") and (out / f"sides/{art['side']}.png").exists():
            e["side"] = f"sides/{art['side']}.png"
        if (out / f"terrain/{t['id']}_sprite.png").exists():
            e["sprite"] = f"terrain/{t['id']}_sprite.png"
        if e:
            terrains[t["id"]] = e
    manifest["terrains"] = terrains
    # another forge run may be writing props for the same pack: merge rather than clobber
    if path.exists():
        try:
            on_disk = json.loads(path.read_text())
            manifest["props"] = {**on_disk.get("props", {}), **manifest["props"]}
        except json.JSONDecodeError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=1))
    tmp.replace(path)


if __name__ == "__main__":
    main()
