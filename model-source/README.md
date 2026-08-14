# Building model source

`hdsfds.glb` (25.8 MB) is the **source artwork** for the demo building. It is
deliberately kept OUTSIDE `public/` so it is never copied into the deployed
build — nothing fetches it at runtime, and shipping it added 25 MB to every
deploy for no user benefit.

What the app actually loads is `public/models/hdsfds.opt.glb` (1.7 MB), which
is generated from this file.

## Why the optimized copy exists

The source is 99.3% textures: 25.53 MB of images against 0.18 MB of geometry
(92 meshes, 12,061 vertices). Eight of its nine textures are 2048×2048, one a
7.9 MB PNG — far beyond what a building occupying a few hundred screen pixels
can resolve.

The cost was not only download. Textures expand to raw RGBA in GPU memory
regardless of file compression, so 31.5 megapixels meant roughly 126 MB of
VRAM (~167 MB mipmapped). The optimized copy needs about 8 MB.

## Regenerating

```bash
npm run build:model          # 1024px WebP — what ships today
npm run build:model -- --size 2048 --quality 90   # higher fidelity, ~6 MB
```

Requires `sharp` (a devDependency — it does the image resizing/encoding).
`npm run build` does **not** run this step, so the generated
`public/models/hdsfds.opt.glb` is committed to the repo: a deploy builds from
the committed artifact and never needs `sharp` or this source file. Re-run
the command and commit the result whenever the source art changes.

Geometry is untouched by this step: mesh count, vertex count and
`EXT_mesh_gpu_instancing` all survive verbatim. Only the images change.

The output uses `EXT_texture_webp`, which is listed in the glTF's
`extensionsRequired`. CesiumJS supports it (it appears in Cesium's own
`supportedExtensions` map). A viewer without that support would fail to load
the model rather than degrade, so re-check if the renderer is ever swapped.

## Editing the source

The other scripts in `scripts/` (`compress_building_model.mjs`,
`instance_repeated_geometry.mjs`, `patch_glass_materials.mjs`) rewrite this
file **in place**. After running any of them, re-run `npm run build:model` to
regenerate the deployed copy — otherwise the app keeps loading the previous
optimized build and your edit appears to have done nothing.
