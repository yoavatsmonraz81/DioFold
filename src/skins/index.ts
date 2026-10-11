import { ProceduralSkin, blueprint, quantizer, sepia } from './procedural';
import type { Skin } from './types';

/** ENDESGA 32 — a well-loved pixel art palette. */
const ENDESGA32 = [
  '#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633',
  '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e',
  '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
  '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569',
];

export const SKINS: Skin[] = [
  new ProceduralSkin({
    id: 'storybook',
    name: 'Storybook',
    blurb: 'Bright, soft and toy-like',
    theme: 'dark',
    layerBg: { sky: 0x9fd6f7, surface: 0x86c3e3, underground: 0x2b2436, deep: 0x1c0f15 },
    style: { color: (c) => c, outline: 'rgba(38,30,52,0.55)', outlineWidth: 1.2, shadeLeft: -0.1, shadeRight: -0.28, wobble: 0, hatch: false, strata: true },
    pattern(ctx, size) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      for (let i = 0; i < 18; i++) {
        ctx.beginPath();
        ctx.arc(((i * 53) % size) + 0.5, ((i * 97) % size) + 0.5, 1 + (i % 3) * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  }),
  new ProceduralSkin({
    id: 'parchment',
    name: 'Parchment',
    blurb: 'Ink on old paper, like a tome map',
    theme: 'light',
    layerBg: { sky: 0xf4e8cc, surface: 0xeedcb5, underground: 0xdcc69e, deep: 0xcbb085 },
    style: { color: sepia, outline: 'rgba(58,36,18,0.9)', outlineWidth: 1.4, shadeLeft: -0.08, shadeRight: -0.2, wobble: 1.6, hatch: true, strata: false },
    pattern(ctx, size) {
      for (let i = 0; i < 260; i++) {
        const x = (i * 7919) % size, y = (i * 104729) % size;
        ctx.fillStyle = i % 2 ? 'rgba(90,60,20,0.06)' : 'rgba(255,255,255,0.10)';
        ctx.fillRect(x, y, 1 + (i % 3), 1);
      }
      ctx.strokeStyle = 'rgba(90,60,20,0.05)';
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.moveTo(0, (i * 41) % size);
        ctx.bezierCurveTo(size / 3, ((i * 41) % size) + 6, (2 * size) / 3, ((i * 41) % size) - 6, size, (i * 41) % size);
        ctx.stroke();
      }
    },
  }),
  new ProceduralSkin({
    id: 'pixel',
    name: 'Pixel',
    blurb: 'Crunchy 32-colour pixel art',
    theme: 'dark',
    layerBg: { sky: 0x0099db, surface: 0x262b44, underground: 0x181425, deep: 0x1a0b12 },
    style: { color: quantizer(ENDESGA32), outline: 'rgba(24,20,37,1)', outlineWidth: 2, shadeLeft: -0.15, shadeRight: -0.35, wobble: 0, hatch: false, strata: true },
    pixelate: { scale: 2, palette: ENDESGA32 },
  }),
  new ProceduralSkin({
    id: 'blueprint',
    name: 'Blueprint',
    blurb: "A cartographer's technical drawing",
    theme: 'dark',
    layerBg: { sky: 0x1b4580, surface: 0x173a6b, underground: 0x122e57, deep: 0x0e2445 },
    style: { color: blueprint, outline: 'rgba(222,236,255,0.9)', outlineWidth: 1, shadeLeft: -0.15, shadeRight: -0.35, wobble: 0, hatch: false, strata: true },
    pattern(ctx, size) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= size; i += size / 8) {
        ctx.beginPath();
        ctx.moveTo(i + 0.5, 0);
        ctx.lineTo(i + 0.5, size);
        ctx.moveTo(0, i + 0.5);
        ctx.lineTo(size, i + 0.5);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.strokeRect(0.5, 0.5, size, size);
    },
  }),
];

export const skinById = (id: string) => SKINS.find((s) => s.id === id) ?? SKINS[0];
