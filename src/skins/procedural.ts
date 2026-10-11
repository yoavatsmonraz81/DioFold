import type { LayerId } from '../core/layers';
import { hexToNum, hexToRgb, nearest, rgbToHex, type RGB } from './color';
import { drawBridge } from './bridge';
import { makeCanvas, paintProp, paintTile, type PaintStyle } from './painter';
import type { BridgeRequest, PropRequest, Rendered, Skin, TileRequest } from './types';

export interface ProceduralSkinDef {
  id: string;
  name: string;
  blurb: string;
  theme: 'dark' | 'light';
  layerBg: Record<LayerId, number>;
  style: PaintStyle;
  pixelate?: { scale: number; palette: string[] };
  pattern?: (ctx: CanvasRenderingContext2D, size: number) => void;
}

/** A skin drawn entirely in code by the shared painter, styled by a PaintStyle. */
export class ProceduralSkin implements Skin {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly theme: 'dark' | 'light';
  readonly layerBg: Record<LayerId, number>;
  readonly nearest: boolean;
  readonly pattern?: (ctx: CanvasRenderingContext2D, size: number) => void;
  private palette: RGB[] | null;

  constructor(private def: ProceduralSkinDef) {
    this.id = def.id;
    this.name = def.name;
    this.blurb = def.blurb;
    this.theme = def.theme;
    this.layerBg = def.layerBg;
    this.nearest = !!def.pixelate;
    this.pattern = def.pattern;
    this.palette = def.pixelate ? def.pixelate.palette.map(hexToRgb) : null;
  }

  renderTile(req: TileRequest): Rendered {
    return this.post(paintTile(req.terrain, req.h, req.variant, req.frame, req.mask, this.def.style));
  }

  renderProp(req: PropRequest): Rendered {
    // code-drawn props already sit small inside their tile, so they only ever grow (for big footprints)
    return this.post(paintProp(req.prop, req.variant, req.frame, this.def.style, Math.max(1, req.width)));
  }

  renderBridge(req: BridgeRequest): Rendered {
    const st = this.def.style;
    return this.post(drawBridge(req, { color: st.color, outline: st.outline, outlineWidth: st.outlineWidth * 0.75, shadeLeft: -st.shadeLeft, shadeRight: -st.shadeRight, res: 1, grain: 0 }));
  }

  tint(hex: string): number {
    return hexToNum(this.def.style.color(hex));
  }

  /** Pixel skins: downsample, snap every pixel to the palette, then scale back up with hard edges. */
  private post(r: Rendered): Rendered {
    if (!this.def.pixelate || !this.palette) return r;
    const k = this.def.pixelate.scale;
    const { width, height } = r.canvas;
    const w = Math.ceil(width / k), h = Math.ceil(height / k);
    const small = makeCanvas(w, h);
    const sc = small.getContext('2d', { willReadFrequently: true })!;
    sc.drawImage(r.canvas, 0, 0, w * k, h * k, 0, 0, w, h);
    const img = sc.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 110) {
        d[i + 3] = 0;
        continue;
      }
      const a = d[i + 3] / 255;
      const [nr, ng, nb] = nearest([d[i] / a, d[i + 1] / a, d[i + 2] / a], this.palette);
      d[i] = nr;
      d[i + 1] = ng;
      d[i + 2] = nb;
      d[i + 3] = 255;
    }
    sc.putImageData(img, 0, 0);
    const big = makeCanvas(width, height);
    const bc = big.getContext('2d')!;
    bc.imageSmoothingEnabled = false;
    bc.drawImage(small, 0, 0, w * k, h * k);
    return { ...r, canvas: big };
  }
}

// ── palette transforms ──

export function sepia(hex: string): string {
  const c = hexToRgb(hex);
  const L = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  const ink: RGB = [74, 52, 32], paper: RGB = [246, 233, 204];
  const t = Math.pow(L, 0.85);
  const base: RGB = [ink[0] + (paper[0] - ink[0]) * t, ink[1] + (paper[1] - ink[1]) * t, ink[2] + (paper[2] - ink[2]) * t];
  return rgbToHex([base[0] * 0.78 + c[0] * 0.22, base[1] * 0.78 + c[1] * 0.22, base[2] * 0.78 + c[2] * 0.22]);
}

export function blueprint(hex: string): string {
  const c = hexToRgb(hex);
  const L = Math.pow((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255, 0.9);
  const dark: RGB = [14, 40, 84], light: RGB = [128, 176, 238];
  return rgbToHex([dark[0] + (light[0] - dark[0]) * L, dark[1] + (light[1] - dark[1]) * L, dark[2] + (light[2] - dark[2]) * L]);
}

export function quantizer(palette: string[]) {
  const rgb = palette.map(hexToRgb);
  return (hex: string) => rgbToHex(nearest(hexToRgb(hex), rgb));
}
