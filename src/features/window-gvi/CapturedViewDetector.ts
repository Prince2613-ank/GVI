import * as Cesium from "cesium";
import { captureCanvas, computeGVIFromDataUrl } from "../../services/gvi";
import { EyePosition } from "./types";

// Ray casting (ViewAnalyzer/RayCastingEngine) tells you what geometry a
// straight line hits. This module answers a different question: what does
// the eye actually SEE, as rendered pixels — real tree crown materials,
// canopy polygons, any vegetation-colored geometry — from that exact
// window's viewpoint. It moves the live camera to the eye position, waits
// for a real frame to render, captures it, classifies "green" pixels with
// the same HSV classifier the main GVI capture flow already uses
// (services/gvi.ts), then restores the camera exactly as it was so this
// doesn't disturb whatever view the user was looking at.

export interface CapturedViewResult {
  gviPercent: number;
  dataUrl: string;
}

function headingFromLocalForward(
  building: { rotationRad: number },
  localEast: number,
  localNorth: number
): number {
  const cosR = Math.cos(building.rotationRad);
  const sinR = Math.sin(building.rotationRad);
  const worldEast = localEast * cosR - localNorth * sinR;
  const worldNorth = localEast * sinR + localNorth * cosR;
  return Math.atan2(worldEast, worldNorth);
}

/** Waits a couple of animation frames so a just-moved camera has actually rendered. */
function waitForRender(viewer: Cesium.Viewer): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      viewer.scene.render();
      requestAnimationFrame(() => {
        viewer.scene.render();
        resolve();
      });
    });
  });
}

export async function captureWindowView(
  viewer: Cesium.Viewer,
  eye: EyePosition,
  building: { rotationRad: number }
): Promise<CapturedViewResult> {
  const savedView = {
    destination: Cesium.Cartesian3.clone(viewer.camera.positionWC),
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
  };

  const heading = headingFromLocalForward(building, eye.forward[0], eye.forward[1]);

  viewer.camera.setView({
    destination: eye.worldPosition,
    orientation: { heading, pitch: 0, roll: 0 },
  });

  await waitForRender(viewer);
  const dataUrl = captureCanvas(viewer.scene.canvas as HTMLCanvasElement);
  const { gviScore } = await computeGVIFromDataUrl(dataUrl, {
    generateMask: false,
    classificationMode: "visual-hsv",
  });

  viewer.camera.setView({
    destination: savedView.destination,
    orientation: {
      heading: savedView.heading,
      pitch: savedView.pitch,
      roll: savedView.roll,
    },
  });

  return { gviPercent: gviScore * 100, dataUrl };
}
