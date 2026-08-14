import * as Cesium from "cesium";

// Waiting for "the scene is actually finished drawing" before screenshotting
// it. Every GVI score is computed from a captured frame, so anything still
// streaming at capture time — terrain tiles, OSM building tiles, tree
// geometry mid-tessellation — is simply absent from the image and therefore
// silently absent from the score. That failure is invisible in the result:
// a window whose trees hadn't arrived yet just reports a low GVI, not an
// error.
//
// The existing waits in useCesium.ts serve the opposite goal — they reveal
// the map as fast as possible on first paint and deliberately time out
// early, because a slightly-unfinished first frame is fine to LOOK at. It
// is not fine to MEASURE. Hence a separate, stricter wait here.

/** Frames the scene must stay quiet for before it counts as settled. */
const STABLE_FRAMES_REQUIRED = 5;

/**
 * Minimum time to keep watching before "quiet" is allowed to mean anything,
 * however quiet the very first frames look.
 *
 * This exists because of how Cesium reports tile readiness.
 * `Cesium3DTileset.tilesLoaded` means "every tile meeting the screen-space
 * error THIS FRAME is loaded", and it is written during the tileset's own
 * traversal. Immediately after the camera jumps to a new window, the
 * tileset has not yet traversed for that new view, so the flag still holds
 * the PREVIOUS viewpoint's value — which was true, because the scene had
 * settled where the camera used to be.
 *
 * Sampling a few frames was therefore reading stale state and passing
 * before the tileset had even worked out which tiles it now needs. The
 * result was exactly the failure this whole module exists to prevent: GVI
 * computed against a view whose surrounding buildings had not arrived.
 *
 * Waiting a beat first guarantees the tileset (and the globe) have
 * re-traversed for the current camera and honestly reported themselves as
 * loading before we start believing them.
 */
const MIN_OBSERVE_MS = 500;

/**
 * Upper bound on the whole wait. Real-world tile streaming over a slow
 * connection can genuinely take this long; capping it means a stalled tile
 * request degrades the score rather than hanging the UI forever.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Which stage the scene is currently blocked on, in the order they resolve. */
export type SceneReadyStage = "terrain" | "city" | "building" | "vegetation" | "ready";

/**
 * What is still loading, if anything — used both to decide readiness and to
 * tell the user which stage is holding things up.
 */
export interface ScenePendingState {
  /** Terrain and imagery for the current view. */
  terrain: boolean;
  /** Surrounding-city 3D Tiles, plus any other tileset in the scene. */
  cityTiles: boolean;
  /** The subject building's own glTF model. */
  buildingModel: boolean;
  /** Batched geometry: tree crowns/trunks, canopy and manual vegetation polygons. */
  vegetation: boolean;
}

/**
 * Walks a primitive collection recursively, since the pieces we care about
 * are nested rather than sitting at the top level: TreeRenderer owns its own
 * PrimitiveCollection, VegetationLayer another under scene.groundPrimitives,
 * and Cesium's DataSourceDisplay wraps entity-backed primitives (including
 * the building's Model) in one of its own.
 */
function walkPrimitives(
  collection: Cesium.PrimitiveCollection,
  visit: (primitive: object) => void
): void {
  for (let i = 0; i < collection.length; i++) {
    const primitive = collection.get(i) as object;
    if (primitive instanceof Cesium.PrimitiveCollection) {
      walkPrimitives(primitive, visit);
      continue;
    }
    visit(primitive);
  }
}

/**
 * A hidden primitive is skipped deliberately. Cesium does not update a
 * primitive with `show === false`, so its `ready` flag can stay false
 * forever — waiting on one would stall until the timeout every single time.
 */
function isHidden(primitive: object): boolean {
  return (primitive as { show?: boolean }).show === false;
}

/** Inspects everything the captured frame depends on, in one pass. */
export function getScenePendingState(scene: Cesium.Scene): ScenePendingState {
  const pending: ScenePendingState = {
    terrain: !scene.globe.tilesLoaded,
    cityTiles: false,
    buildingModel: false,
    vegetation: false,
  };

  const visit = (primitive: object) => {
    if (isHidden(primitive)) return;

    if (primitive instanceof Cesium.Cesium3DTileset) {
      if (!primitive.tilesLoaded) pending.cityTiles = true;
      return;
    }
    if (primitive instanceof Cesium.Model) {
      // The subject building. Its glTF is fetched and parsed separately
      // from everything else, so it can still be arriving long after the
      // terrain around it has settled.
      if (!primitive.ready) pending.buildingModel = true;
      return;
    }
    // Cesium.Primitive / GroundPrimitive / ClassificationPrimitive all
    // expose `ready`, and all tessellate asynchronously on a worker — this
    // is the tree crowns, trunks, canopy and manual vegetation polygons.
    const ready = (primitive as { ready?: boolean }).ready;
    if (typeof ready === "boolean" && !ready) pending.vegetation = true;
  };

  walkPrimitives(scene.primitives, visit);
  walkPrimitives(scene.groundPrimitives, visit);

  return pending;
}

/** Nothing the capture depends on is still loading. */
export function isSceneQuiet(pending: ScenePendingState): boolean {
  return (
    !pending.terrain && !pending.cityTiles && !pending.buildingModel && !pending.vegetation
  );
}

/**
 * Resolves once the globe's terrain/imagery and every 3D tileset have
 * finished loading for the CURRENT camera position and have stayed that way
 * for a few consecutive frames.
 *
 * The consecutive-frame requirement is the important part. `tilesLoaded`
 * reports "the load queue is empty right now", which flickers true in the
 * gap between one batch of tiles finishing and the next batch (revealed by
 * those tiles becoming visible) being requested. Sampling it once would
 * routinely resolve into the middle of a still-loading view.
 *
 * Under requestRenderMode the scene may not be drawing at all while we
 * wait, so each poll explicitly requests a render — otherwise postRender
 * would never fire again and this would sit until the timeout.
 */
export function waitForSceneReady(
  viewer: Cesium.Viewer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  /** Called as the blocking stage changes, so the UI can name what it's waiting on. */
  onProgress?: (stage: SceneReadyStage) => void
): Promise<void> {
  return new Promise((resolve) => {
    const { scene } = viewer;
    let stableFrames = 0;
    let settled = false;
    let lastStage: SceneReadyStage | null = null;

    const reportStage = (pending: ScenePendingState) => {
      // Reported in the order things actually resolve: the ground arrives
      // first, then the city around it, then the building, then its trees.
      const stage: SceneReadyStage = pending.terrain
        ? "terrain"
        : pending.cityTiles
          ? "city"
          : pending.buildingModel
            ? "building"
            : pending.vegetation
              ? "vegetation"
              : "ready";
      if (stage !== lastStage) {
        lastStage = stage;
        onProgress?.(stage);
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      removeListener();
      clearTimeout(timeoutId);
      resolve();
    };

    const startedAt = performance.now();

    const removeListener = scene.postRender.addEventListener(() => {
      const pending = getScenePendingState(scene);
      reportStage(pending);

      // Keep the scene rendering so the globe and every tileset actually
      // re-traverse for the current camera — under requestRenderMode they
      // would otherwise never update, and their "loaded" flags would stay
      // frozen at whatever the previous viewpoint left behind.
      scene.requestRender();

      // Ignore however good the first half-second looks; see MIN_OBSERVE_MS.
      if (performance.now() - startedAt < MIN_OBSERVE_MS) {
        stableFrames = 0;
        return;
      }

      if (isSceneQuiet(pending)) {
        stableFrames++;
        if (stableFrames >= STABLE_FRAMES_REQUIRED) {
          finish();
        }
        return;
      }
      stableFrames = 0;
    });

    const timeoutId = setTimeout(() => {
      console.warn(
        "[sceneReady] Timed out waiting for the scene to finish loading; " +
          "capturing anyway — the resulting GVI may under-report. Still " +
          `pending: ${JSON.stringify(getScenePendingState(scene))}`
      );
      finish();
    }, timeoutMs);

    // Kick the first frame; without this nothing would drive the listener
    // above when the scene is already idle.
    scene.requestRender();
  });
}
