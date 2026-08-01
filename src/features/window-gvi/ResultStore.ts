import { ViewDirectionName, WindowResult } from "./types";

// In-memory store of completed WindowResults, plus CSV/JSON export. Kept as
// a small class (not raw component state) so WindowOverlay's heatmap
// coloring, WindowPopup's detail view, and the export buttons all read from
// one source of truth instead of three copies drifting apart.

const EXPORT_DIRECTIONS: ViewDirectionName[] = ["North", "South", "East", "West", "Forward"];

export class ResultStore {
  private results = new Map<string, WindowResult>();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  set(result: WindowResult): void {
    this.results.set(result.windowId, result);
    this.notify();
  }

  get(windowId: string): WindowResult | undefined {
    return this.results.get(windowId);
  }

  getAll(): WindowResult[] {
    return Array.from(this.results.values());
  }

  clear(): void {
    this.results.clear();
    this.notify();
  }

  toJson(): string {
    return JSON.stringify(this.getAll(), null, 2);
  }

  toCsv(): string {
    const header = [
      "WindowID",
      "Floor",
      "Flat",
      "Room",
      ...EXPORT_DIRECTIONS,
      "Average",
      "Average360",
      "CapturedViewGVI",
      "EyeLatitude",
      "EyeLongitude",
      "EyeHeightM",
      "AnalyzedAt",
    ];
    const rows = this.getAll().map((w) => {
      const byDirection = new Map(w.directions.map((d) => [d.direction, d.gviPercent]));
      return [
        w.windowId,
        String(w.floor),
        w.flat,
        w.room,
        ...EXPORT_DIRECTIONS.map((d) => (byDirection.get(d) ?? "").toString()),
        w.averageGviPercent.toFixed(2),
        w.average360GviPercent !== undefined ? w.average360GviPercent.toFixed(2) : "",
        w.capturedViewGviPercent !== undefined ? w.capturedViewGviPercent.toFixed(2) : "",
        w.eyePosition.latitude.toFixed(7),
        w.eyePosition.longitude.toFixed(7),
        w.eyeHeightM.toFixed(2),
        w.analyzedAtIso,
      ]
        .map(csvEscape)
        .join(",");
    });
    return [header.join(","), ...rows].join("\n");
  }
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
