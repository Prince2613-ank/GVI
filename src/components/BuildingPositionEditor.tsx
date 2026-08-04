import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { DEFAULT_LOCATION, DEFAULT_VIEW, MODEL_BASE_OFFSET_M } from "../utils/constants";
import { INITIAL_BUILDING } from "../config/building";

const READ_THROTTLE_MS = 150;

interface OrbitPose {
  rangeM: number;
  headingDeg: number;
  pitchDeg: number;
}

/** Everything else about the live camera — read-only, not editable here (edit rangeM/headingDeg/pitchDeg above instead, which drive these indirectly). */
interface CameraTelemetry {
  longitude: number;
  latitude: number;
  heightM: number;
  rollDeg: number;
  fovDeg: number;
  aspectRatio: number;
}

interface DefaultViewEditorProps {
  viewer: Cesium.Viewer | null;
}

// Same center the real reveal (useCesium.ts's flyToDefaultView/runIntroOrbit)
// orbits around — kept in sync here so this card previews the identical pose
// model, not an approximation of it.
const buildingCenter = Cesium.Cartesian3.fromDegrees(
  DEFAULT_LOCATION.longitude,
  DEFAULT_LOCATION.latitude,
  DEFAULT_LOCATION.height + MODEL_BASE_OFFSET_M * INITIAL_BUILDING.scale + 100
);

/**
 * Live, two-way debug card for dialing in DEFAULT_VIEW (utils/constants.ts)
 * — the initial camera pose shown on page load.
 *
 * This is an ORBIT model, matching exactly how the real reveal positions
 * the camera (viewer.camera.lookAt with a HeadingPitchRange around the
 * building's center) — NOT a free lon/lat/height camera position. That
 * distinction matters: with a free pose, changing "distance" also silently
 * changed how centered the building looked (it wasn't re-aimed at the
 * building as it moved back), which is why pull-back and zoom used to feel
 * tangled together. Range here is purely "how far back," fully independent
 * of heading/pitch ("which angle") — the building stays centered at any
 * range.
 *
 * Type here -> camera moves: a field change calls camera.lookAt directly
 * (instant, not a flight), then releases the lock (lookAtTransform back to
 * IDENTITY) so normal mouse controls still work afterward.
 *
 * Move the camera (drag/pan/zoom/rotate) -> fields update: a throttled
 * scene.postRender listener reads the live camera's distance/heading/pitch
 * relative to the same building center back into the fields.
 */
export function BuildingPositionEditor({ viewer }: DefaultViewEditorProps) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [position, setPosition] = useState({ top: 80, left: 16 });
  const [pose, setPose] = useState<OrbitPose>(DEFAULT_VIEW);
  const [telemetry, setTelemetry] = useState<CameraTelemetry | null>(null);
  const dragState = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({
    dragging: false,
    offsetX: 0,
    offsetY: 0,
  });

  const lastReadRef = useRef(0);
  useEffect(() => {
    if (!viewer) return;
    function onPostRender() {
      const now = performance.now();
      if (now - lastReadRef.current < READ_THROTTLE_MS) return;
      lastReadRef.current = now;

      const camera = viewer!.camera;
      const rangeM = Cesium.Cartesian3.distance(camera.positionWC, buildingCenter);
      setPose({
        rangeM,
        headingDeg: Cesium.Math.toDegrees(camera.heading),
        pitchDeg: Cesium.Math.toDegrees(camera.pitch),
      });

      const cartographic = Cesium.Cartographic.fromCartesian(camera.positionWC);
      const frustum = camera.frustum as Cesium.PerspectiveFrustum;
      const fov = frustum.fov;
      const aspectRatio = frustum.aspectRatio;
      setTelemetry({
        longitude: Cesium.Math.toDegrees(cartographic.longitude),
        latitude: Cesium.Math.toDegrees(cartographic.latitude),
        heightM: cartographic.height,
        rollDeg: Cesium.Math.toDegrees(camera.roll),
        fovDeg: typeof fov === "number" && Number.isFinite(fov) ? Cesium.Math.toDegrees(fov) : 0,
        aspectRatio: typeof aspectRatio === "number" && Number.isFinite(aspectRatio) ? aspectRatio : 0,
      });
    }
    viewer.scene.postRender.addEventListener(onPostRender);
    return () => {
      viewer.scene.postRender.removeEventListener(onPostRender);
    };
  }, [viewer]);

  function onHeaderMouseDown(event: React.MouseEvent) {
    dragState.current = {
      dragging: true,
      offsetX: event.clientX - position.left,
      offsetY: event.clientY - position.top,
    };
    function onMove(moveEvent: MouseEvent) {
      if (!dragState.current.dragging) return;
      const margin = 40;
      const maxLeft = Math.max(0, window.innerWidth - margin);
      const maxTop = Math.max(0, window.innerHeight - margin);
      setPosition({
        left: Math.min(maxLeft, Math.max(0, moveEvent.clientX - dragState.current.offsetX)),
        top: Math.min(maxTop, Math.max(0, moveEvent.clientY - dragState.current.offsetY)),
      });
    }
    function onUp() {
      dragState.current.dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function applyPose(next: OrbitPose) {
    setPose(next);
    if (!viewer) return;
    viewer.camera.lookAt(
      buildingCenter,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(next.headingDeg),
        Cesium.Math.toRadians(next.pitchDeg),
        next.rangeM
      )
    );
    // Releases the lookAt lock immediately so normal drag/scroll controls
    // keep working afterward — same pattern the intro orbit uses.
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    viewer.scene.requestRender();
  }

  function setField(field: keyof OrbitPose, raw: string) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    applyPose({ ...pose, [field]: value });
  }

  const fields: { key: keyof OrbitPose; label: string; step: string }[] = [
    { key: "rangeM", label: "Range — pull back (m)", step: "1" },
    { key: "headingDeg", label: "Heading (deg)", step: "0.1" },
    { key: "pitchDeg", label: "Pitch (deg)", step: "0.1" },
  ];

  return (
    <div className="building-pos-editor" style={{ top: position.top, left: position.left }}>
      <div className="building-pos-editor__header" onMouseDown={onHeaderMouseDown}>
        <span>🎥 Default View</span>
        <button
          type="button"
          className="minimize-btn"
          title={isMinimized ? "Expand" : "Minimize"}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setIsMinimized((value) => !value)}
        >
          {isMinimized ? "▢" : "—"}
        </button>
      </div>
      {!isMinimized && (
        <div className="building-pos-editor__body">
          {fields.map(({ key, label, step }) => (
            <label className="building-pos-editor__field" key={key}>
              <span>{label}</span>
              <input
                type="number"
                step={step}
                value={Math.round(pose[key] * 100) / 100}
                onChange={(event) => setField(key, event.target.value)}
                disabled={!viewer}
              />
            </label>
          ))}
          <p className="building-pos-editor__hint">
            Live — Range pulls back/zooms in, always centered on the
            building. Copy these into DEFAULT_VIEW in utils/constants.ts.
          </p>

          {telemetry && (
            <>
              <div className="building-pos-editor__divider">Live Camera Telemetry</div>
              <div className="building-pos-editor__readout">
                <span>Longitude</span><span>{telemetry.longitude.toFixed(7)}</span>
                <span>Latitude</span><span>{telemetry.latitude.toFixed(7)}</span>
                <span>Height (m)</span><span>{telemetry.heightM.toFixed(2)}</span>
                <span>Roll (deg)</span><span>{telemetry.rollDeg.toFixed(2)}</span>
                <span>FOV (deg)</span><span>{telemetry.fovDeg.toFixed(2)}</span>
                <span>Aspect ratio</span><span>{telemetry.aspectRatio.toFixed(3)}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
