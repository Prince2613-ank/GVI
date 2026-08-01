import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { BuildingTransform } from "../services/camera";

// Reads the building entity's actual rendered position/orientation every
// frame (via scene.postRender) and diffs it against the target transform
// state. Position is set with ConstantPositionProperty/ConstantProperty
// (see CesiumViewer), so it never moves on its own — this panel exists to
// make that verifiable on screen instead of taken on faith: if the camera
// angle ever nudges the model, the delta fields below will show it as a
// nonzero drift immediately.

interface BuildingPositionDebugProps {
  viewer: Cesium.Viewer | null;
  buildingEntity: Cesium.Entity | null;
  building: BuildingTransform;
}

interface LiveReading {
  latitude: number;
  longitude: number;
  height: number;
  headingDeg: number;
}

const UPDATE_INTERVAL_MS = 200;

export function BuildingPositionDebug({
  viewer,
  buildingEntity,
  building,
}: BuildingPositionDebugProps) {
  const [reading, setReading] = useState<LiveReading | null>(null);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    if (!viewer || !buildingEntity) return;

    function onPostRender() {
      const now = performance.now();
      if (now - lastUpdateRef.current < UPDATE_INTERVAL_MS) return;
      lastUpdateRef.current = now;

      const time = viewer!.clock.currentTime;
      const position = buildingEntity!.position?.getValue(time);
      if (!position) return;

      const carto = Cesium.Cartographic.fromCartesian(position);
      const orientation = buildingEntity!.orientation?.getValue(time);
      let headingDeg = 0;
      if (orientation) {
        // headingPitchRollQuaternion (used to set orientation) bakes the
        // local east-north-up frame at `position` into the quaternion, so
        // recovering heading requires factoring that frame back out before
        // reading off HeadingPitchRoll — reading the quaternion directly
        // would report a rotation relative to world axes, not north.
        const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(position);
        const fixedToEnuRotation = Cesium.Matrix4.getMatrix3(
          Cesium.Matrix4.inverseTransformation(enuToFixed, new Cesium.Matrix4()),
          new Cesium.Matrix3()
        );
        const fixedToEnuQuat = Cesium.Quaternion.fromRotationMatrix(fixedToEnuRotation);
        const localQuat = Cesium.Quaternion.multiply(
          fixedToEnuQuat,
          orientation,
          new Cesium.Quaternion()
        );
        const hpr = Cesium.HeadingPitchRoll.fromQuaternion(localQuat);
        headingDeg = Cesium.Math.toDegrees(hpr.heading);
      }

      setReading({
        latitude: Cesium.Math.toDegrees(carto.latitude),
        longitude: Cesium.Math.toDegrees(carto.longitude),
        height: carto.height,
        headingDeg,
      });
    }

    viewer.scene.postRender.addEventListener(onPostRender);
    return () => {
      viewer.scene.postRender.removeEventListener(onPostRender);
    };
  }, [viewer, buildingEntity]);

  if (!reading) return null;

  const latDrift = reading.latitude - building.latitude;
  const lonDrift = reading.longitude - building.longitude;
  const heightDrift = reading.height - building.height;
  const targetHeadingDeg = Cesium.Math.toDegrees(building.rotationRad);
  const headingDrift =
    ((((reading.headingDeg - targetHeadingDeg) % 360) + 540) % 360) - 180;

  const EPS = 1e-6;
  const locked =
    Math.abs(latDrift) < EPS &&
    Math.abs(lonDrift) < EPS &&
    Math.abs(heightDrift) < 1e-3 &&
    Math.abs(headingDrift) < 1e-3;

  return (
    <fieldset className="panel">
      <legend>Building Position Debug</legend>
      <div className={locked ? "debug-status locked" : "debug-status drift"}>
        {locked ? "LOCKED — no drift" : "DRIFT DETECTED"}
      </div>
      <table className="debug-table">
        <tbody>
          <tr>
            <td>Lat</td>
            <td>{reading.latitude.toFixed(7)}</td>
            <td>{latDrift.toExponential(2)}</td>
          </tr>
          <tr>
            <td>Lon</td>
            <td>{reading.longitude.toFixed(7)}</td>
            <td>{lonDrift.toExponential(2)}</td>
          </tr>
          <tr>
            <td>Height (m)</td>
            <td>{reading.height.toFixed(3)}</td>
            <td>{heightDrift.toExponential(2)}</td>
          </tr>
          <tr>
            <td>Heading (deg)</td>
            <td>{reading.headingDeg.toFixed(3)}</td>
            <td>{headingDrift.toExponential(2)}</td>
          </tr>
        </tbody>
      </table>
    </fieldset>
  );
}
