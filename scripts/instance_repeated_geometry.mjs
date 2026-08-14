// Further lossless optimization on top of compress_building_model.mjs's
// dedup/weld/prune pass — converts nodes that repeatedly reference the same
// mesh (e.g. a repeated window/floor unit across many stories) into
// EXT_mesh_gpu_instancing. Same geometry, same triangles, same materials —
// this only changes how the GPU is told to draw them (one instanced draw
// call per shared mesh instead of one draw call per node), which is a
// runtime perf win. Whether it also reduces file size depends on how much
// redundant per-node overhead the original export baked in.
//
// Run with: node scripts/instance_repeated_geometry.mjs
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { instance, dedup, prune } from "@gltf-transform/functions";
import { statSync } from "fs";

const MODEL_PATH = new URL("../model-source/hdsfds.glb", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(MODEL_PATH);

const beforeBytes = statSync(MODEL_PATH).size;
const beforeNodes = doc.getRoot().listNodes().length;

await doc.transform(
  instance({ min: 2 }), // any mesh reused by 2+ nodes becomes an instanced batch
  dedup(),
  prune()
);

await io.write(MODEL_PATH, doc);

const afterBytes = statSync(MODEL_PATH).size;
const afterNodes = doc.getRoot().listNodes().length;
const savedPct = (((beforeBytes - afterBytes) / beforeBytes) * 100).toFixed(1);
// eslint-disable-next-line no-console
console.log(
  `hdsfds.glb: ${(beforeBytes / 1024 / 1024).toFixed(2)}MB -> ${(afterBytes / 1024 / 1024).toFixed(2)}MB (${savedPct}% smaller)\n` +
    `nodes: ${beforeNodes} -> ${afterNodes} (fewer nodes = fewer draw calls at runtime)`
);
