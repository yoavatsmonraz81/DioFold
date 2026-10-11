"""Post-processing for forged art: seamless textures and keyed-out sprites."""
import numpy as np
from PIL import Image
from scipy import ndimage


def _blend_wrap(a: np.ndarray, axis: int, band: float = 0.35) -> np.ndarray:
    """Make `a` wrap seamlessly along one axis by cross-fading with a half-rolled copy near the edges."""
    n = a.shape[axis]
    rolled = np.roll(a, n // 2, axis=axis)
    t = np.linspace(0, 1, n)
    edge = np.minimum(t, 1 - t)  # 0 at the borders, 0.5 in the middle
    m = np.clip(edge / band, 0, 1)
    m = m * m * (3 - 2 * m)  # smoothstep
    shape = [1, 1, 1]
    shape[axis] = n
    m = m.reshape(shape)
    return a * m + rolled * (1 - m)


def flatten(a: np.ndarray, strength: float = 0.8, sigma_frac: float = 0.1) -> np.ndarray:
    """Divide out large-scale light and hue variation (blotches, gradients, bands) so tiling doesn't show a pattern."""
    out = np.empty_like(a)
    for c in range(3):
        blur = ndimage.gaussian_filter(a[..., c], sigma=a.shape[0] * sigma_frac, mode="reflect")
        out[..., c] = a[..., c] * (a[..., c].mean() / np.maximum(blur, 1.0)) ** strength
    return out.clip(0, 255)


def seamless(img: Image.Image, size: int = 512) -> Image.Image:
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    a = flatten(a)
    a = _blend_wrap(a, axis=1)
    a = _blend_wrap(a, axis=0)
    out = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    return out.resize((size, size), Image.LANCZOS)


def despill(rgb: np.ndarray, bg: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Remove the key colour's cast: fully on soft edges, partly inside (it bleeds into glass and metal)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    weight = np.where(alpha < 0.98, 1.0, 0.7)
    out = rgb.copy()
    if bg[1] > max(bg[0], bg[2]):  # green key
        spill = np.clip(g - np.maximum(r, b), 0, None) * weight
        out[..., 1] = g - spill
    else:  # magenta key
        spill = np.clip(np.minimum(r, b) - g, 0, None) * weight
        out[..., 0] = r - spill
        out[..., 2] = b - spill
    return out.clip(0, 255)


def cast_shadow(a: np.ndarray, bg: np.ndarray, fg: np.ndarray) -> np.ndarray:
    """How shadow-like each pixel is: the key colour darkened (same hue, 40-85% as bright). Object pixels almost
    never sit on that line; a cast shadow the model painted onto the backdrop does."""
    norm = np.linalg.norm(a, axis=-1)
    cos = (a @ bg) / (norm * np.linalg.norm(bg) + 1e-6)
    ratio = norm / np.linalg.norm(bg)
    s = np.clip((cos - 0.97) / 0.015, 0, 1) * np.clip((ratio - 0.35) / 0.08, 0, 1) * np.clip((0.88 - ratio) / 0.05, 0, 1)
    return np.where(fg, s, 0)


def key_sprite(img: Image.Image, max_w: int = 512, max_h: int = 640, drop_shadow: bool = False):
    """Remove a flat background. Returns (RGBA image, anchor_x, anchor_y, raw_width): the anchor is normalised
    to the footprint centre (where the object meets the ground of its tile); raw_width is the object's width in
    the generated image, so views of one object can keep their relative scale."""
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    b = 6
    border = np.concatenate([a[:b].reshape(-1, 3), a[-b:].reshape(-1, 3), a[:, :b].reshape(-1, 3), a[:, -b:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    d = np.sqrt(((a - bg) ** 2).sum(-1))

    alpha = np.clip((d - 38) / (95 - 38), 0, 1)
    if drop_shadow:  # edits like to add a cast shadow; only strip it when there's clearly one there
        s = cast_shadow(a, bg, alpha > 0.5)
        if (s > 0.5).sum() > 0.08 * (alpha > 0.5).sum():
            alpha = alpha * (1 - s)
    alpha[alpha < 0.06] = 0

    # drop specks: keep components with a meaningful share of the largest one
    lab, n = ndimage.label(alpha > 0.3)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(alpha), lab, range(1, n + 1))
        keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * 0.04])
        alpha = np.where(keep | (alpha < 0.3) & ndimage.binary_dilation(keep, iterations=3), alpha, 0)

    al = alpha[..., None]
    rgb = np.where(al > 0.02, (a - (1 - al) * bg) / np.maximum(al, 0.02), 0).clip(0, 255)
    rgb = despill(rgb, bg, alpha)
    rgba = np.dstack([rgb, alpha * 255]).astype(np.uint8)
    im = Image.fromarray(rgba, "RGBA")
    bbox = Image.fromarray((alpha > 0.1).astype(np.uint8) * 255).getbbox()
    if not bbox:
        raise ValueError("sprite came out empty after keying")
    im = im.crop(bbox)
    raw_w = im.width
    scale = min(max_w / im.width, max_h / im.height, 1.0)
    if scale < 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)

    # anchor: centre of the footprint, estimated from the opaque pixels in the bottom band
    al2 = np.asarray(im)[..., 3] > 128
    rows = np.where(al2.any(axis=1))[0]
    bottom = rows.max()
    band_top = max(0, bottom - int((bottom - rows.min()) * 0.15))
    ys, xs = np.nonzero(al2[band_top : bottom + 1])
    foot_w = xs.max() - xs.min() + 1 if len(xs) else im.width
    ax = (xs.mean() if len(xs) else im.width / 2) / im.width
    ay = (bottom - 0.25 * foot_w * 0.9) / im.height
    return im, round(float(ax), 4), round(float(ay), 4), raw_w
