import * as Cesium from "cesium";
import { TreeSpeciesProfile } from "./treeSpecies";

// Billboard impostors for the far LOD tier (LOD3) — a small canvas-drawn
// silhouette per species canopy shape, cached and reused so Cesium's
// BillboardCollection only has to atlas ~9 unique images total (one per
// species profile) rather than one per tree. Deliberately uses each
// species' base color (not the per-tree jittered color from
// jitteredCanopyColor) — at billboard viewing distance individual-tree
// color variation isn't perceptible, and reusing exactly one image per
// species keeps the atlas bounded regardless of tree count.

const billboardCache = new Map<string, HTMLCanvasElement>();

function hslToCss([h, s, l]: [number, number, number]): string {
  return Cesium.Color.fromHsl(h, s, l).toCssColorString();
}

export function getSpeciesBillboardImage(profile: TreeSpeciesProfile): HTMLCanvasElement {
  const cached = billboardCache.get(profile.name);
  if (cached) return cached;

  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const canopyColor = hslToCss(profile.canopyHsl);
  const trunkColor = profile.trunkColor.toCssColorString();

  ctx.fillStyle = trunkColor;
  ctx.fillRect(size / 2 - 2, size * 0.72, 4, size * 0.26);

  ctx.fillStyle = canopyColor;
  const ellipse = (cx: number, cy: number, rx: number, ry: number) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  switch (profile.canopyShape) {
    case "cone":
      ctx.beginPath();
      ctx.moveTo(size / 2, size * 0.05);
      ctx.lineTo(size * 0.16, size * 0.74);
      ctx.lineTo(size * 0.84, size * 0.74);
      ctx.closePath();
      ctx.fill();
      break;
    case "column":
      ellipse(size / 2, size * 0.4, size * 0.16, size * 0.36);
      break;
    case "umbrella":
      ellipse(size / 2, size * 0.24, size * 0.42, size * 0.13);
      break;
    case "multiLayer":
      ellipse(size / 2, size * 0.58, size * 0.36, size * 0.15);
      ellipse(size / 2, size * 0.4, size * 0.28, size * 0.13);
      ellipse(size / 2, size * 0.24, size * 0.18, size * 0.11);
      break;
    case "irregular":
      ellipse(size * 0.38, size * 0.36, size * 0.2, size * 0.19);
      ellipse(size * 0.62, size * 0.32, size * 0.19, size * 0.21);
      ellipse(size * 0.5, size * 0.52, size * 0.22, size * 0.18);
      break;
    case "oval":
      ellipse(size / 2, size * 0.35, size * 0.26, size * 0.3);
      break;
    case "round":
    default:
      ctx.beginPath();
      ctx.arc(size / 2, size * 0.38, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
  }

  billboardCache.set(profile.name, canvas);
  return canvas;
}
