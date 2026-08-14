// One-off asset patch: the building GLB's real window glass — materials
// "Solid_Glass" and "01_-_Default" (identified via `gltf-transform inspect
// model-source/hdsfds.glb`, cross-referenced by instance count against the
// mesh names actually named "*Glass*") — was exported as a BLEND material
// with a near-black baseColorFactor (~[0.03, 0.03, 0.07]) at ~50% alpha.
// That's technically translucent, but tinting everything behind it almost
// black is what read as a hazy, opaque-looking blue wall instead of clear
// glass, both from outside and — worse — looking OUT through a window from
// inside a room/balcony.
//
// This can't be fixed at runtime with a CustomShader: CustomShader's
// translucencyMode setting applies to the model's entire draw call, not
// per-fragment/per-material, so forcing translucency to fix just the glass
// broke depth-sorting for the whole building (see git history on
// src/components/CesiumViewer.tsx). Patching the actual glTF material lets
// Cesium's normal per-primitive alpha blending render it correctly instead.
//
// Run with: node scripts/patch_glass_materials.mjs
// Requires @gltf-transform/core + @gltf-transform/extensions as devDependencies.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const MODEL_PATH = new URL("../model-source/hdsfds.glb", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const GLASS_MATERIAL_NAMES = ["Solid_Glass", "01_-_Default"];
const CLEAR_GLASS_COLOR = [0.86, 0.93, 0.97];
const CLEAR_GLASS_ALPHA = 0.16;

// Registering every known extension keeps the round-trip lossless — this
// GLB uses KHR_materials_specular/KHR_materials_ior, and reading/writing
// without registering them silently strips both from the output.
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(MODEL_PATH);

let patched = 0;
for (const material of doc.getRoot().listMaterials()) {
  if (GLASS_MATERIAL_NAMES.includes(material.getName())) {
    material.setBaseColorFactor([...CLEAR_GLASS_COLOR, CLEAR_GLASS_ALPHA]);
    patched += 1;
  }
}

if (patched !== GLASS_MATERIAL_NAMES.length) {
  throw new Error(
    `Expected to patch ${GLASS_MATERIAL_NAMES.length} glass materials, patched ${patched} — material names in the GLB may have changed.`
  );
}

await io.write(MODEL_PATH, doc);
// eslint-disable-next-line no-console
console.log(`Patched ${patched} glass materials in ${MODEL_PATH}`);
