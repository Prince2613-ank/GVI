import { BalconyViewpointCollection } from "./BalconyTypes";
import { BalconyGviResult } from "./BalconyAnalysis";
import { buildExportCollection } from "./BalconyGeoJson";

// The File System Access API (showSaveFilePicker/FileSystemFileHandle) isn't
// in TS's default DOM lib yet — these are the minimal shapes this module
// actually uses, not a full polyfill of the spec.
export interface BalconyFileHandle {
  name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<BalconyFileHandle>;

function getPicker(): SaveFilePicker | undefined {
  return (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && typeof getPicker() === "function";
}

/**
 * Prompts the user once to choose (or create) the single balcony_viewpoints.geojson
 * file on disk that every subsequent capture/save/delete will silently overwrite —
 * so all 10 floors keep landing in that one file instead of a new download each time.
 */
export async function pickBalconyFileHandle(): Promise<BalconyFileHandle | null> {
  const picker = getPicker();
  if (!picker) return null;
  try {
    return await picker({
      suggestedName: "balcony_viewpoints.geojson",
      types: [{ description: "GeoJSON", accept: { "application/geo+json": [".geojson"] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

export async function writeBalconyFile(
  handle: BalconyFileHandle,
  collection: BalconyViewpointCollection,
  analysisResults?: Map<string, BalconyGviResult>
): Promise<void> {
  const exportCollection = buildExportCollection(collection, analysisResults);
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(exportCollection, null, 2));
  await writable.close();
}
