// Thin client for the backend's shared, cross-visitor resolved-terrain-
// height cache (backend/src/routes/vegetationHeights.ts) — reuses the same
// backend the balcony-viewpoints/GVI leaderboard features already talk to
// (see balconyGenerationApi.ts), just a different base path.

const API_BASE =
  (import.meta.env.VITE_BALCONY_API_URL as string | undefined)?.replace(
    /\/api\/balcony-viewpoints\/?$/,
    "/api/vegetation-heights"
  ) ?? "http://localhost:4100/api/vegetation-heights";

export interface HeightKey {
  polygonId: string;
  clientUpdatedAt: number;
}

export interface ResolvedHeight extends HeightKey {
  heightM: number;
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`vegetation-heights API ${path} failed (${response.status})`);
  return response.json() as Promise<T>;
}

/** Looks up already-resolved heights for a batch of polygons — misses (never resolved by ANY visitor before) simply aren't in the returned array. */
export async function lookupVegetationHeights(keys: HeightKey[]): Promise<ResolvedHeight[]> {
  if (keys.length === 0) return [];
  const { heights } = await request<{ heights: ResolvedHeight[] }>("/lookup", { keys });
  return heights;
}

/** Saves newly-resolved heights so every future visitor (not just this browser) skips re-sampling terrain for these polygons. */
export async function saveVegetationHeights(entries: ResolvedHeight[]): Promise<void> {
  if (entries.length === 0) return;
  await request("/save", { entries });
}
