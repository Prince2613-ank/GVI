import { useCallback, useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { pickBalconyPosition, makeBalconyFeature } from "./BalconyCapture";
import { BalconySide, BalconyViewpointFeature } from "./BalconyTypes";

interface UseBalconyCaptureOptions {
  viewer: Cesium.Viewer | null;
  currentId: string;
  floor: number;
  side: BalconySide;
  balcony: number;
  onCaptured: (feature: BalconyViewpointFeature) => void;
}

export function useBalconyCapture({
  viewer,
  currentId,
  floor,
  side,
  balcony,
  onCaptured,
}: UseBalconyCaptureOptions) {
  const [isCapturing, setIsCapturing] = useState(false);
  const paramsRef = useRef({ currentId, floor, side, balcony });
  paramsRef.current = { currentId, floor, side, balcony };

  useEffect(() => {
    if (!viewer || !isCapturing) return;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const position = pickBalconyPosition(viewer, event.position);
      if (!position) return;
      const { currentId: id, floor: f, side: s, balcony: b } = paramsRef.current;
      const feature = makeBalconyFeature(id, f, s, b, position);
      onCaptured(feature);
      setIsCapturing(false);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    return () => handler.destroy();
  }, [viewer, isCapturing, onCaptured]);

  useEffect(() => {
    if (!isCapturing) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsCapturing(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isCapturing]);

  const startCapture = useCallback(() => setIsCapturing(true), []);
  const cancelCapture = useCallback(() => setIsCapturing(false), []);

  return { isCapturing, startCapture, cancelCapture };
}
