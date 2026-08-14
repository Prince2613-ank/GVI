import { rgbToHsv } from "./HSV";
import { BinaryMask } from "./Morphology";

// Trunks and branches are vegetation, but they are not green — so the
// foliage classifier (VegetationDetector.ts, which requires a 45-170deg hue
// AND green dominance over both red and blue) rejects every trunk pixel by
// design. A tree standing right in front of a window was therefore having
// only its canopy counted, and its trunk scored as if it were empty sky or
// wall.
//
// Brown is the hardest colour to classify in an urban scene — pavement,
// soil, brick, roofing and shadowed concrete all land near it — so a plain
// "is this pixel brown?" test would wreck the score far more than the
// missing trunks ever did. Two extra constraints make it safe:
//
//   1. The trunk palette this app renders is KNOWN (see treeSpecies.ts).
//      Every trunk colour sits in a narrow 24-39deg hue band, comfortably
//      clear of the foliage band above it. Only Phong shading moves those
//      pixels, and shading changes brightness far more than hue, so the
//      hue/saturation window can be tight while the value window stays wide.
//   2. A woody region only counts when it is physically attached to
//      detected foliage AND is taller than it is wide. A trunk meets its
//      own canopy and runs vertically; a brown roof or road surface
//      satisfies neither.

/** Hue band of the rendered trunk palette, widened slightly for shading and antialiasing. */
const MIN_HUE_DEG = 18;
const MAX_HUE_DEG = 44;
/** Bark is never fully desaturated (that would be concrete) nor vivid (that would be paint or brick). */
const MIN_SATURATION = 0.18;
const MAX_SATURATION = 0.75;
/** Wide, because Phong shading drives trunk brightness well above and below the base palette. */
const MIN_VALUE = 0.12;
const MAX_VALUE = 0.72;

/**
 * A trunk must be at least this many times taller than it is wide. Real
 * rendered trunks are extremely elongated; brown ground and roof patches
 * are broad and flat, so this single test removes most of them.
 */
const MIN_ASPECT_RATIO = 1.5;

/** Ignores speckle that survived the colour test but is too small to be a trunk. */
const MIN_COMPONENT_PX = 12;

export function isWoodyPixel(r: number, g: number, b: number): boolean {
  const { h, s, v } = rgbToHsv(r, g, b);
  return (
    h >= MIN_HUE_DEG &&
    h <= MAX_HUE_DEG &&
    s >= MIN_SATURATION &&
    s <= MAX_SATURATION &&
    v >= MIN_VALUE &&
    v <= MAX_VALUE &&
    // Bark always reads red > green > blue. Grey/blue-grey surfaces that
    // drift into the hue band above fail here.
    r > g &&
    g > b
  );
}

/**
 * Keeps only those woody regions that behave like trunks: connected (via an
 * 8-neighbourhood, so a one-pixel antialiased seam still counts) to a pixel
 * already classified as foliage, and vertically elongated.
 *
 * Returns a mask of the accepted woody pixels — the caller unions it into
 * the vegetation mask.
 */
export function extractTrunks(
  woodyCandidates: BinaryMask,
  foliageMask: BinaryMask
): BinaryMask {
  const { width, height, data } = woodyCandidates;
  const out = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);

  for (let startY = 0; startY < height; startY++) {
    for (let startX = 0; startX < width; startX++) {
      const startIdx = startY * width + startX;
      if (data[startIdx] === 0 || visited[startIdx]) continue;

      let sp = 0;
      stack[sp++] = startIdx;
      visited[startIdx] = 1;

      const component: number[] = [];
      let touchesFoliage = false;
      let minX = startX;
      let maxX = startX;
      let minY = startY;
      let maxY = startY;

      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % width;
        const y = (idx - x) / width;
        component.push(idx);

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nIdx = ny * width + nx;
            // Any foliage pixel bordering this region proves attachment —
            // checked on the neighbour rather than the component itself,
            // since the two masks are disjoint by construction.
            if (foliageMask.data[nIdx] === 1) touchesFoliage = true;
            if (data[nIdx] === 1 && !visited[nIdx]) {
              visited[nIdx] = 1;
              stack[sp++] = nIdx;
            }
          }
        }
      }

      if (!touchesFoliage) continue;
      if (component.length < MIN_COMPONENT_PX) continue;

      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      if (boxHeight < boxWidth * MIN_ASPECT_RATIO) continue;

      for (const idx of component) out[idx] = 1;
    }
  }

  return { data: out, width, height };
}
