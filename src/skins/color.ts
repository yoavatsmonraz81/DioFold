export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** amt < 0 darkens toward black, amt > 0 lightens toward white. */
export function shadeHex(hex: string, amt: number): string {
  const c = hexToRgb(hex);
  return rgbToHex(mixRgb(c, amt < 0 ? [0, 0, 0] : [255, 255, 255], Math.abs(amt)));
}

export const luminance = ([r, g, b]: RGB) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
export const hexToNum = (hex: string) => parseInt(hex.replace('#', ''), 16);

/** Perceptually weighted ("redmean") nearest colour. */
export function nearest(c: RGB, palette: RGB[]): RGB {
  let best = palette[0], bestD = Infinity;
  for (const p of palette) {
    const rm = (c[0] + p[0]) / 2;
    const dr = c[0] - p[0], dg = c[1] - p[1], db = c[2] - p[2];
    const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    if (d < bestD) (bestD = d), (best = p);
  }
  return best;
}
