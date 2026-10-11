# DioFold

A toy-like isometric map builder for world builders. Paint biomes onto a 2.5D diorama, sculpt
mountains, carve caves, and flip between stacked world layers: **Sky, Surface, Underground, The Deep**.
Swap the whole look instantly between skins.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

## Controls

| Action | Input |
| --- | --- |
| Paint / Fill / Raise / Lower / Place things / Erase / Pan | `B` `F` `R` `L` `P` `E` `H` |
| Pick from palette | `1`–`9`, `0` |
| Brush size (1×1, 3×3, 5×5) | `[` `]` (a big brush *scatters* props) |
| Layer up / down | `W` `S` or `PageUp` `PageDown` |
| Generate current layer | `G` or 🎲 |
| Pan | right-drag, middle-drag, or hold `Space` |
| Zoom | scroll wheel |
| Recenter | `Home` or `.` |
| Turn the map right / left | `Q` / `Shift+Q` (or ⟳ ⟲ bottom-right) |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) |
| Mute | `M` |

With the Place tool, the bar above the palette shows the selected thing's footprint (e.g. 2×2) and its
size; − / + resize it for the whole pack. The **Tile size** control under the layers sets how much world
one tile holds on the current layer.

The world autosaves to the browser. 💾 / 📂 download and open `.json` world files; 🖼️ exports the current layer as a PNG.

## Architecture

```
src/
  core/            pure data, no rendering
    geometry.ts    tile size, height step, iso projection
    layers.ts      the four stacked layers
    terrains.ts    terrain definitions (+ base colours)
    props.ts       placeable things (trees, castles, boats…)
    world.ts       the grid: layers → cells {terrain, height, prop}, per-layer tile size; change events; JSON save format
    footprint.ts   how many cells a prop covers (its size ÷ the layer's tile size), occupancy
    history.ts     undo/redo grouped by stroke
    edit.ts        editing rules (paint keeps sculpted height, liquids are flat, flood fill…)
    generate.ts    per-layer procedural generators (islands, CA caves, magma depths, sky isles)
    rng.ts         seeded RNG + value noise
  skins/
    types.ts       the Skin interface — anything that can draw a tile or prop
    painter.ts     the shared procedural painter (all terrains & props drawn in canvas code)
    procedural.ts  ProceduralSkin = painter + PaintStyle (+ optional pixelation pass)
    index.ts       the skins: Storybook, Parchment, Pixel, Blueprint
  render/
    MapView.ts     PixiJS scene: texture cache, layers & ghosting, animation, picking, camera
  ui/sound.ts      tiny WebAudio synth (no audio files)
  app.ts           tools, input, palette/toolbar UI, persistence
vite.config.ts     dev-only endpoint that saves prop sizes from the app into pack.json
```

**Key idea: the map data never knows how it looks.** A cell is just `{ t: 'forest', h: 3, p: 'castle' }`.
A skin turns `(terrain, height, variant, animation frame, foam mask)` into an image. That's what makes skins
swappable and what lets new art sources plug in.

### Adding things

- **Terrain:** add an entry to `core/terrains.ts`, then a `case` in `painter.ts` → `topDetails` (and optionally `tallDetails`).
- **Prop:** add to `core/props.ts` and a function in `PROP_PAINTERS` in `painter.ts`.
- **Procedural skin:** add a `ProceduralSkin` in `skins/index.ts`. A skin is mostly a colour transform
  (`sepia`, `blueprint`, `quantizer(palette)`) plus outline/shading/wobble/hatching settings.
- **Image skin:** implement `Skin` from `skins/types.ts` with sprite-sheet lookups. Nothing else changes.

## World packs & the forge

A **pack** is one setting: its layer names, terrains, props, and how the 🎲 generators map onto them. The
repository ships the built-in **Classic** pack; your own worlds are packs you add. Each pack terrain/prop names
a built-in `base`, which gives it behaviour (liquid, height rules…) and a procedural fallback look, so every
skin works on every pack. The **Painted** skin draws a pack with art made by the forge, a ComfyUI pipeline
(Krea 2 Turbo for sprites and textures, Qwen Image Edit 2511 for turned views).

Pack folders (`src/packs/<id>/` and their art in `public/packs/<id>/`) are **git-ignored**: your worlds stay
on your machine unless you choose to share one (add a `!src/packs/<id>/` line to `.gitignore`).

### Make your own world

1. **Write `src/packs/<id>/pack.json`.** The app picks up every pack folder by itself. A minimal pack:

   ```json
   {
     "id": "mossy-hollow",
     "name": "Mossy Hollow",
     "subtitle": "A drowned forest",
     "style": "storybook watercolour fantasy illustration, soft light",
     "layers": [
       { "id": "sky", "name": "Canopy", "icon": "🍃", "blurb": "Up in the leaves", "generator": "sky", "blank": null },
       { "id": "surface", "name": "The Hollow", "icon": "🌳", "blurb": "Roots and pools", "generator": "surface", "blank": { "t": "pool", "h": 0 } },
       { "id": "underground", "name": "Burrows", "icon": "🐾", "blurb": "Under the roots", "generator": "underground", "blank": { "t": "earthwall", "h": 2 } },
       { "id": "deep", "name": "The Sump", "icon": "🌊", "blurb": "Where the water goes", "generator": null, "blank": { "t": "earthwall", "h": 2 } }
     ],
     "sides": { "loam": "dark loamy earth with roots and pebbles" },
     "terrains": [
       { "id": "moss", "name": "Moss", "layers": ["surface"], "base": "grass", "art": { "top": "thick green moss with tiny ferns", "side": "loam" } },
       { "id": "pool", "name": "Pool", "layers": ["surface"], "base": "water", "art": { "top": "still green pond water with lily pads" } },
       { "id": "earthwall", "name": "Earth", "layers": ["underground", "deep"], "base": "wall", "art": { "top": "packed dark earth", "side": "loam" } }
     ],
     "props": [
       { "id": "oldoak", "name": "Old oak", "layers": ["surface"], "base": "tree", "foot": 1.5, "prompt": "a huge gnarled oak tree covered in moss" },
       { "id": "stump", "name": "Stump house", "layers": ["surface"], "base": "house", "prompt": "a cosy house built inside a tree stump, round door" }
     ],
     "generate": {
       "surface": { "terrains": { "grass": "moss", "forest": "moss", "water": "pool", "shallows": "pool" }, "props": { "tree": "oldoak", "house": "stump" } }
     }
   }
   ```

   - **Layers** fill the four fixed slots (sky → deep). `generator` picks a 🎲 generator (`sky`, `surface`,
     `underground`, `deep`, `city`, `hive`, or `null`); `blank` is what 🧹 Clear fills the layer with.
   - **Terrains and props** extend a built-in `base` (see `src/core/terrains.ts` and `src/core/props.ts`).
     `foot` is a prop's size in tiles (below). `art.top` / `prompt` / `sides` are what the forge paints.
   - **`generate`** maps the generators' built-in ids onto yours; unmapped props are left out.
2. **Forge the art** (optional: without it the procedural skins draw everything). Start ComfyUI, then with
   ComfyUI's Python:

   ```bash
   python tools/forge/forge.py mossy-hollow                          # forge everything missing
   python tools/forge/forge.py mossy-hollow --only oldoak --force    # redo one asset
   python tools/forge/forge.py mossy-hollow --only oldoak --force --seed 3   # …with a different look
   python tools/forge/forge.py mossy-hollow --views                  # turned views for map rotation
   COMFY_HOST=http://127.0.0.1:8189 python tools/forge/forge.py mossy-hollow   # use a second ComfyUI
   ```

3. **Review and size it:** `tools/forge/sheet.py <id> props` (or `terrain`, `views`) makes contact sheets,
   `tools/forge/measure.py <id>` a size sheet; adjust sizes with the size bar in the app.

How the forge works:

- Terrain `art.top` → a seamless top-down texture. Tiles show a slice of it chosen by map position,
  so neighbouring cells join without seams. `art.side` names a shared cliff texture from `sides`.
- Prop `prompt` → an isometric sprite on a flat key colour, keyed out, trimmed, and anchored at its footprint.
- Output goes to `public/packs/<id>/` with an `assets.json` manifest; full-size raw generations go to
  `forge-raw/<id>/` (git-ignored), so `--repost` can redo keying/seamless processing without regenerating.
- The running app hot-swaps new art as the forge writes it.

### Sizes, footprints & turning the map

- Each prop has a **`foot`**: its size in tiles at tile size 1 (one tile ≈ a house lot), either one number
  for a square footprint or `[along x, along y]` for a long one (`"foot": [1, 2]` for an arch; x runs
  down-right on screen in the default view, y down-left). On a layer each side becomes `round(size ÷ tile size)`
  cells, 1 to 4. Things smaller than a tile keep
  one cell and are drawn narrower; things bigger than 4×4 are drawn shrunk to fit. A placed prop is stored on
  the front corner of its footprint; the other cells are worked out from it. Placing a big prop levels the
  ground under it and clears what was there. Raising or lowering any of its cells moves the whole footprint,
  and erasing or painting water under it removes it. Generators place big things first and thin repeats.
- `python tools/forge/measure.py <pack>` prints every prop's footprint and drawn size and draws
  `forge-raw/<pack>/sizes.png`: each prop on its footprint grid, all at one scale, so outliers stand out.
  `--tile 2` shows a 2× layer. New props the forge makes get a proposed `foot` (from their base and name);
  fine-tune with the size bar in the app (− / + for size, the shape button for square / long ↘ / long ↙), which
  writes into `pack.json` when running `npm run dev`.
- **Turning the map** (`Q`) swings the board round on a turntable, then redraws it from the new side. Props
  can have a forged view for each quarter-turn: `forge.py <pack> --views` makes the 90°/180°/270° views
  from each prop's raw image with Qwen Image Edit 2511 (about 10 s per view). Without them, odd turns show
  the sprite mirrored. Edits sometimes tip a tall thing over or add a cast shadow: the forge checks each view's
  shape against the main sprite and retries, strips painted-on shadows, and `--views --fix` redoes any that
  still fail. Review with `sheet.py <pack> views`; set a view to `false` in `assets.json` to keep the mirror.

## Roadmap ideas

- Forge: pick between several candidates per asset in-app; style-reference from concept art (Krea 2 edit LoRAs).
- Links between layers (cave entrances, stairs, beanstalks) shown on both layers.
- Labels & map annotations (place names, notes, lore pins).
- Touch gestures (pinch zoom, two-finger pan) and bigger / resizable maps.
- Per-placement facing (turn a single building), now that props have four views.
- Neighbour-aware edges (sand rims on coasts, cliff outlines only where heights differ).
