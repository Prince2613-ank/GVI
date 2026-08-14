// Texture optimization for the building GLB — the single largest loading
// cost in the whole app.
//
// Measured before writing this: hdsfds.glb is 25.8 MB, of which 25.53 MB is
// textures and only 0.18 MB is geometry (12,061 vertices). Eight of its nine
// images are 2048x2048, one of them a 7.9 MB PNG. That is 31.5 megapixels,
// which the GPU expands to roughly 126 MB of VRAM (about 167 MB once
// mipmapped) regardless of how compressed the file on disk is.
//
// compress_building_model.mjs deliberately leaves textures alone (it is
// lossless-only: dedup/weld/prune). It therefore cannot help here, because
// the file is essentially all texture.
//
// The building occupies a few hundred pixels on screen in the aerial view
// and is only ever seen from outside or through its own windows — 2048px
// source art is far beyond what any of those views can resolve.
//
// Run with: node scripts/compress_building_textures.mjs [--size 1024] [--quality 82]
// Writes a NEW file alongside the original so the source art is never
// destroyed; point BUILDING_MODEL_URL at it once you are happy with the look.

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { textureCompress } from "@gltf-transform/functions";
import { statSync } from "fs";
import sharp from "sharp";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MAX_SIZE = parseInt(arg("size", "1024"), 10);
const QUALITY = parseInt(arg("quality", "82"), 10);

const resolve = (p) =>
  new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const SRC = resolve("../model-source/hdsfds.glb");
const OUT = resolve(`../public/models/hdsfds.opt.glb`);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(SRC);

const before = statSync(SRC).size;
console.log(`source: ${(before / 1e6).toFixed(2)} MB`);
console.log(`target: max ${MAX_SIZE}px, quality ${QUALITY}\n`);

for (const texture of doc.getRoot().listTextures()) {
  const size = texture.getSize();
  console.log(
    `  ${texture.getName() || "(unnamed)"} ${size?.[0]}x${size?.[1]} ${texture.getMimeType()}`
  );
}

await doc.transform(
  // WebP at these dimensions is dramatically smaller than both the source
  // PNGs and JPEGs at visually equivalent quality, and every browser that
  // can run WebGL 2 (which this app already requires) decodes it natively.
  textureCompress({
    encoder: sharp,
    targetFormat: "webp",
    resize: [MAX_SIZE, MAX_SIZE],
    quality: QUALITY,
  })
);

await io.write(OUT, doc);

const after = statSync(OUT).size;
console.log(
  `\nwrote ${OUT}` +
    `\n  ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB` +
    `  (${(100 - (after / before) * 100).toFixed(1)}% smaller)`
);
console.log(
  "\nOriginal left untouched. To adopt: point BUILDING_MODEL_URL in" +
    "\nsrc/utils/constants.ts at /models/hdsfds.opt.glb and compare visually."
);
