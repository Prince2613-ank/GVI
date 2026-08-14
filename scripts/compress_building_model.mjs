// Lossless size reduction for the building GLB — no geometry quantization,
// no texture recompression, nothing that changes how it looks. Only removes
// genuinely redundant data: duplicate materials/textures/accessors (dedup),
// unused nodes/meshes/materials left over from edits (prune), and
// exact-duplicate vertices within floating-point tolerance (weld) — the
// same kind of cleanup patch_glass_materials.mjs already does a read/write
// round-trip for, just with different transforms applied.
//
// Run with: node scripts/compress_building_model.mjs
// Requires @gltf-transform/core + @gltf-transform/extensions +
// @gltf-transform/functions as devDependencies.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, weld } from "@gltf-transform/functions";
import { statSync } from "fs";

const MODEL_PATH = new URL("../model-source/hdsfds.glb", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(MODEL_PATH);

const beforeBytes = statSync(MODEL_PATH).size;

await doc.transform(
  dedup(),
  weld({ tolerance: 0 }), // 0 = only exact-duplicate vertices, never moves geometry
  prune()
);

await io.write(MODEL_PATH, doc);

const afterBytes = statSync(MODEL_PATH).size;
const savedPct = (((beforeBytes - afterBytes) / beforeBytes) * 100).toFixed(1);
// eslint-disable-next-line no-console
console.log(
  `hdsfds.glb: ${(beforeBytes / 1024 / 1024).toFixed(2)}MB -> ${(afterBytes / 1024 / 1024).toFixed(2)}MB (${savedPct}% smaller, lossless)`
);
