import * as Cesium from "cesium";
import { ManualVegetationPolygon } from "../types/ManualVegetationTypes";

export interface RasterMask {
  width: number;
  height: number;
  /** 0/1 per pixel, row-major, at (width x height) resolution. */
  data: Uint8Array;
  pixelCount: number;
}

/** Present at runtime (used internally by Cesium's own 3D Tiles picking) but not declared in this version's TS types. */
interface ScenePickFromRay {
  pickFromRay(ray: Cesium.Ray, objectsToExclude?: unknown[]): { position?: Cesium.Cartesian3 } | undefined;
}

/**
 * A vertex being "in front of the camera" doesn't mean it's actually
 * visible — a manual vegetation polygon behind/inside a building from the
 * current viewpoint would otherwise still get projected and filled onto the
 * mask, producing green blobs in the GVI result at building interiors that
 * have no real greenery in the captured screenshot at all. This casts a ray
 * from the camera to the vertex and rejects it if something else (the
 * building's own geometry) is hit meaningfully closer than the vertex
 * itself.
 */
function isOccluded(scene: Cesium.Scene, cameraPosition: Cesium.Cartesian3, position: Cesium.Cartesian3): boolean {
  try {
    const toPoint = Cesium.Cartesian3.subtract(position, cameraPosition, new Cesium.Cartesian3());
    const targetDistance = Cesium.Cartesian3.magnitude(toPoint);
    const direction = Cesium.Cartesian3.normalize(toPoint, new Cesium.Cartesian3());
    const ray = new Cesium.Ray(cameraPosition, direction);
    const result = (scene as unknown as ScenePickFromRay).pickFromRay(ray, []);
    if (!result?.position) return false;
    const hitDistance = Cesium.Cartesian3.distance(cameraPosition, result.position);
    // A generous tolerance so the vegetation polygon's own surface (which
    // pickFromRay may itself hit, since it's drawn roughly at the building
    // facade/ground) doesn't get treated as self-occlusion.
    return hitDistance < targetDistance - 0.5;
  } catch {
    // pickFromRay isn't supported in every context (e.g. no WebGL2/depth
    // texture support) — fail OPEN so projection still works, just without
    // the occlusion guard, rather than hiding all manual vegetation.
    return false;
  }
}

/** Projects a world position to CANVAS BACKING-STORE pixels (not CSS pixels), or undefined if behind the camera or occluded by other scene geometry. */
function projectToCanvasPixel(
  viewer: Cesium.Viewer,
  position: Cesium.Cartesian3,
  scaleX: number,
  scaleY: number
): Cesium.Cartesian2 | undefined {
  const scene = viewer.scene;
  const window = Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, new Cesium.Cartesian2());
  if (!window || !Number.isFinite(window.x) || !Number.isFinite(window.y)) return undefined;

  // worldToWindowCoordinates doesn't itself reject points behind the camera.
  const toPoint = Cesium.Cartesian3.subtract(position, scene.camera.positionWC, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.dot(toPoint, scene.camera.directionWC) <= 0) return undefined;

  if (isOccluded(scene, scene.camera.positionWC, position)) return undefined;

  return new Cesium.Cartesian2(window.x * scaleX, window.y * scaleY);
}

/**
 * Projects every saved manual vegetation polygon that's actually in front of
 * the camera into canvas-pixel space and rasterizes them (via 2D canvas
 * path fill, which handles overlapping polygons and concave rings for
 * free) into a binary mask matching the captured image's resolution.
 *
 * Must be called at the moment the view being captured is actually what's
 * on screen — it reads the viewer's LIVE camera, so callers should invoke
 * this immediately around canvas.toDataURL(), not later.
 */
export function projectManualVegetation(
  viewer: Cesium.Viewer,
  polygons: ManualVegetationPolygon[],
  width: number,
  height: number
): RasterMask {
  const canvas = viewer.scene.canvas as HTMLCanvasElement;
  const scaleX = canvas.clientWidth > 0 ? width / canvas.clientWidth : 1;
  const scaleY = canvas.clientHeight > 0 ? height / canvas.clientHeight : 1;

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const ctx = maskCanvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to acquire 2D canvas context for manual vegetation projection");
  }

  let anyDrawn = false;
  ctx.fillStyle = "#ffffff";

  for (const polygon of polygons) {
    if (polygon.positions.length < 3) continue;

    const projected: Cesium.Cartesian2[] = [];
    let allVisible = true;
    for (const p of polygon.positions) {
      const world = Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude);
      const screen = projectToCanvasPixel(viewer, world, scaleX, scaleY);
      if (!screen) {
        allVisible = false;
        break;
      }
      projected.push(screen);
    }
    // A polygon with any vertex behind the camera OR occluded by other scene
    // geometry (e.g. behind/inside the building from this viewpoint) is
    // skipped rather than drawn — conservative, but avoids both the classic
    // "point behind camera projects into the canvas rect" failure mode and
    // vegetation that isn't actually visible bleeding into the mask.
    if (!allVisible || projected.length < 3) continue;

    // Cheap reject: polygon's projected bounding box entirely outside canvas.
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    if (Math.max(...xs) < 0 || Math.min(...xs) > width || Math.max(...ys) < 0 || Math.min(...ys) > height) {
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(projected[0].x, projected[0].y);
    for (let i = 1; i < projected.length; i++) {
      ctx.lineTo(projected[i].x, projected[i].y);
    }
    ctx.closePath();
    ctx.fill();
    anyDrawn = true;
  }

  const data = new Uint8Array(width * height);
  let pixelCount = 0;
  if (anyDrawn) {
    const imageData = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < width * height; i++) {
      if (imageData.data[i * 4] > 0) {
        data[i] = 1;
        pixelCount++;
      }
    }
  }

  return { width, height, data, pixelCount };
}

/** Renders a raw projected mask as a translucent green overlay PNG — for the "Show Projected Vegetation" debug toggle. */
export function rasterMaskToPreviewDataUrl(mask: RasterMask): string {
  const canvas = document.createElement("canvas");
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to acquire 2D canvas context for manual vegetation mask preview");
  }
  const imageData = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    const o = i * 4;
    if (mask.data[i] === 1) {
      imageData.data[o] = 0;
      imageData.data[o + 1] = 255;
      imageData.data[o + 2] = 0;
      imageData.data[o + 3] = 160;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}
