import { IndoorZone } from "./IndoorZone";

/**
 * Single source of truth for "are we currently in Indoor Camera Mode". A
 * plain module-level object (not React state) since the camera controller
 * needs to read/write it synchronously from Cesium event handlers, not from
 * a render cycle. React components (the indoor navigation overlay) observe
 * it via subscribeIndoorState + useSyncExternalStore instead.
 */
export interface IndoorCameraState {
  isIndoor: boolean;
  /** Ellipsoidal height (meters) the camera is locked to while indoor — set on enter(), held until exit(). */
  eyeHeight: number | null;
  /** The current viewpoint's local movement boundary — see IndoorZone.ts. Set on enter(), cleared on exit(). */
  zone: IndoorZone | null;
}

export const indoorState: IndoorCameraState = {
  isIndoor: false,
  eyeHeight: null,
  zone: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Subscribes to isIndoor/eyeHeight changes; returns an unsubscribe function. Pairs with useSyncExternalStore. */
export function subscribeIndoorState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getIsIndoorSnapshot(): boolean {
  return indoorState.isIndoor;
}

export function setIndoorEntered(eyeHeight: number, zone: IndoorZone): void {
  indoorState.isIndoor = true;
  indoorState.eyeHeight = eyeHeight;
  indoorState.zone = zone;
  notify();
}

export function setIndoorExited(): void {
  indoorState.isIndoor = false;
  indoorState.eyeHeight = null;
  indoorState.zone = null;
  notify();
}
