import { WindowMetadata } from "./types";

// WindowManager owns the authoritative list of windows for the current
// building: loading them from a JSON metadata file (Method 1), or
// auto-detecting them by parsing the GLB's own glTF node names for
// "window"/"glass" (Method 2, case-insensitive per the spec).

interface RawWindowJson {
  id: string;
  floor: number;
  flat: string;
  room: string;
  position: [number, number, number];
  normal: [number, number, number];
  width: number;
  height: number;
}

function isRawWindowJson(value: unknown): value is RawWindowJson {
  if (!value || typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.floor === "number" &&
    typeof w.flat === "string" &&
    typeof w.room === "string" &&
    Array.isArray(w.position) &&
    w.position.length === 3 &&
    Array.isArray(w.normal) &&
    w.normal.length === 3 &&
    typeof w.width === "number" &&
    typeof w.height === "number"
  );
}

export class WindowManager {
  private windows: WindowMetadata[] = [];

  getWindows(): WindowMetadata[] {
    return this.windows;
  }

  getWindow(id: string): WindowMetadata | undefined {
    return this.windows.find((w) => w.id === id);
  }

  getWindowsForFloor(floor: number): WindowMetadata[] {
    return this.windows.filter((w) => w.floor === floor);
  }

  clear(): void {
    this.windows = [];
  }

  /** Method 1: parse+validate a JSON metadata array (see types.ts's shape). */
  loadFromJson(raw: unknown): { loaded: number; rejected: number } {
    if (!Array.isArray(raw)) {
      throw new Error("Window metadata JSON must be an array of window objects.");
    }
    const loaded: WindowMetadata[] = [];
    let rejected = 0;
    for (const entry of raw) {
      if (!isRawWindowJson(entry)) {
        rejected++;
        continue;
      }
      loaded.push({
        id: entry.id,
        floor: entry.floor,
        flat: entry.flat,
        room: entry.room,
        position: entry.position,
        normal: entry.normal,
        width: entry.width,
        height: entry.height,
        source: "json",
      });
    }
    this.windows = loaded;
    return { loaded: loaded.length, rejected };
  }

  /**
   * Method 2: fetch the GLB, parse its glTF JSON chunk directly (no external
   * loader — a .glb is just a binary header + a JSON chunk + a binary
   * buffer chunk, per the glTF 2.0 spec), and pull out every node whose
   * name contains "window" or "glass" (case-insensitive). The node's local
   * translation becomes the window position; since raw glTF nodes rarely
   * carry a usable outward-facing normal, the normal is left as
   * building-relative "up" (0,0,1) and the caller (WindowGVIPanel) should
   * prompt the user to fix normals per-window, or fall back to JSON, when
   * this matters for accuracy.
   *
   * Returns an empty array (not a throw) when no matching nodes are found,
   * per the spec's "if automatic detection fails, use JSON" fallback.
   */
  async detectFromGlb(glbUrl: string): Promise<WindowMetadata[]> {
    const response = await fetch(glbUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch GLB for window detection: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const gltf = parseGlbJsonChunk(buffer);
    if (!gltf) {
      this.windows = [];
      return [];
    }

    const nodes: unknown[] = Array.isArray(gltf.nodes) ? gltf.nodes : [];
    const detected: WindowMetadata[] = [];
    let counter = 0;

    for (const nodeUnknown of nodes) {
      const node = nodeUnknown as {
        name?: string;
        translation?: [number, number, number];
      };
      const name = node.name ?? "";
      if (!/window|glass/i.test(name)) continue;

      const [x, y, z] = node.translation ?? [0, 0, 0];
      counter++;
      // glTF is Y-up; this app's local frame is [east, north, up]. Assume
      // the model's +X is local east and +Z (glTF forward) is local -north
      // (i.e. the model was authored facing local south) — verify visually
      // via WindowOverlay's markers and re-export/adjust if that's wrong
      // for a given model.
      detected.push({
        id: `AUTO-${counter}-${name || "window"}`,
        floor: 0,
        flat: "unknown",
        room: "unknown",
        position: [x, -z, y],
        normal: [0, -1, 0],
        width: 1.2,
        height: 1.4,
        source: "auto",
      });
    }

    this.windows = detected;
    return detected;
  }
}

interface MinimalGltf {
  nodes?: unknown[];
}

/** Parses just enough of the GLB binary container to reach the JSON chunk. */
function parseGlbJsonChunk(buffer: ArrayBuffer): MinimalGltf | null {
  const view = new DataView(buffer);
  const MAGIC = 0x46546c67; // "glTF"
  if (view.byteLength < 12 || view.getUint32(0, true) !== MAGIC) return null;

  let offset = 12; // past the 12-byte header (magic, version, total length)
  while (offset + 8 <= view.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const JSON_CHUNK_TYPE = 0x4e4f534a; // "JSON"
    if (chunkType === JSON_CHUNK_TYPE) {
      const jsonBytes = new Uint8Array(buffer, chunkStart, chunkLength);
      const text = new TextDecoder("utf-8").decode(jsonBytes);
      try {
        return JSON.parse(text) as MinimalGltf;
      } catch {
        return null;
      }
    }
    offset = chunkStart + chunkLength;
  }
  return null;
}
