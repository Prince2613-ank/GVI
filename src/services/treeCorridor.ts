import { latLonToLocalMeters, haversineDistanceM, offsetLatLon } from "../utils/geo";
import { VegetationPoint } from "./vegetation";

// treeCorridor.ts groups individual street trees into street-tree "rows":
// trees planted close enough together (see TREE_CHAIN_LINK_DISTANCE_M) are
// merged into a single buffered-polyline polygon that follows their planted
// sequence along the block, instead of each rendering as its own separate
// canopy circle. This is what gives a tree-lined street continuous canopy
// coverage rather than a line of dots. A tree with no near neighbor stays a
// single point — VegetationLayer falls back to a plain canopy circle for it.

export interface TreeCorridor {
  id: string;
  /** Ids of every tree merged into this corridor, for obstruction lookups. */
  treeIds: string[];
  color: string;
  /** Closed ring (buffered strip boundary) to feed straight into a Cesium polygon hierarchy. */
  ring: { latitude: number; longitude: number }[];
}

export interface TreeCorridorResult {
  corridors: TreeCorridor[];
  singles: VegetationPoint[];
}

interface LocalPoint {
  tree: VegetationPoint;
  eastM: number;
  northM: number;
}

/** Groups trees into connected clusters via single-linkage over linkDistanceM. */
function clusterTrees(trees: VegetationPoint[], linkDistanceM: number): VegetationPoint[][] {
  const parent = trees.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < trees.length; i++) {
    for (let j = i + 1; j < trees.length; j++) {
      const d = haversineDistanceM(
        trees[i].latitude,
        trees[i].longitude,
        trees[j].latitude,
        trees[j].longitude
      );
      if (d <= linkDistanceM) union(i, j);
    }
  }

  const groups = new Map<number, VegetationPoint[]>();
  for (let i = 0; i < trees.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(trees[i]);
    else groups.set(root, [trees[i]]);
  }
  return [...groups.values()];
}

/** Orders a cluster's trees into a walkable sequence via nearest-neighbor chaining. */
function orderAlongPath(cluster: VegetationPoint[]): VegetationPoint[] {
  if (cluster.length <= 2) return cluster;

  const remaining = [...cluster];
  // Start from the point farthest from the cluster centroid — usually one
  // end of the row — so the walk traces the row instead of starting mid-line.
  const centroidLat = remaining.reduce((s, t) => s + t.latitude, 0) / remaining.length;
  const centroidLon = remaining.reduce((s, t) => s + t.longitude, 0) / remaining.length;
  let startIdx = 0;
  let maxDist = -1;
  remaining.forEach((t, i) => {
    const d = haversineDistanceM(t.latitude, t.longitude, centroidLat, centroidLon);
    if (d > maxDist) {
      maxDist = d;
      startIdx = i;
    }
  });

  const ordered: VegetationPoint[] = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let nearestIdx = 0;
    let nearestDist = Infinity;
    remaining.forEach((t, i) => {
      const d = haversineDistanceM(last.latitude, last.longitude, t.latitude, t.longitude);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    });
    ordered.push(remaining.splice(nearestIdx, 1)[0]);
  }
  return ordered;
}

function normalize(v: { x: number; y: number }): { x: number; y: number } {
  const len = Math.hypot(v.x, v.y);
  return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

/**
 * Buffers an ordered chain of local-plane points into a ribbon-shaped ring:
 * each point is offset perpendicular to its local direction of travel (the
 * average of its incoming/outgoing segment for interior points), producing
 * a left-side boundary walked forward and a right-side boundary walked
 * back, closed into one ring. Good enough for the gentle curvature of a
 * city block's tree row; not a general-purpose polyline buffer.
 */
function bufferChain(
  points: LocalPoint[],
  radiusM: number
): { eastM: number; northM: number }[] {
  const left: { eastM: number; northM: number }[] = [];
  const right: { eastM: number; northM: number }[] = [];

  for (let i = 0; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const dirs: { x: number; y: number }[] = [];
    if (prev) {
      dirs.push(normalize({ x: curr.eastM - prev.eastM, y: curr.northM - prev.northM }));
    }
    if (next) {
      dirs.push(normalize({ x: next.eastM - curr.eastM, y: next.northM - curr.northM }));
    }
    const avg = dirs.reduce(
      (acc, d) => ({ x: acc.x + d.x, y: acc.y + d.y }),
      { x: 0, y: 0 }
    );
    const dir = normalize(avg);
    // Perpendicular to (x,y) is (-y,x); fall back to a fixed east-west
    // perpendicular for the degenerate zero-direction case (never expected
    // for a real 2+ point chain, but keeps this total).
    const perp = dir.x === 0 && dir.y === 0 ? { x: 1, y: 0 } : { x: -dir.y, y: dir.x };

    left.push({
      eastM: curr.eastM + perp.x * radiusM,
      northM: curr.northM + perp.y * radiusM,
    });
    right.push({
      eastM: curr.eastM - perp.x * radiusM,
      northM: curr.northM - perp.y * radiusM,
    });
  }

  return [...left, ...right.reverse()];
}

/**
 * Groups trees into street-row corridor polygons plus a leftover list of
 * trees that had no near neighbor (rendered as single canopy circles instead).
 */
export function groupTreesIntoCorridors(
  trees: VegetationPoint[],
  linkDistanceM: number,
  radiusM: number
): TreeCorridorResult {
  const clusters = clusterTrees(trees, linkDistanceM);
  const corridors: TreeCorridor[] = [];
  const singles: VegetationPoint[] = [];

  for (const cluster of clusters) {
    if (cluster.length < 2) {
      singles.push(...cluster);
      continue;
    }

    const ordered = orderAlongPath(cluster);
    const origin = ordered[0];
    const localPoints: LocalPoint[] = ordered.map((tree) => {
      const { eastM, northM } = latLonToLocalMeters(
        origin.latitude,
        origin.longitude,
        tree.latitude,
        tree.longitude
      );
      return { tree, eastM, northM };
    });

    const ringLocal = bufferChain(localPoints, radiusM);
    const ring = ringLocal.map((p) =>
      offsetLatLon(origin.latitude, origin.longitude, p.eastM, p.northM)
    );

    corridors.push({
      id: `corridor-${ordered.map((t) => t.id).join("-")}`,
      treeIds: ordered.map((t) => t.id),
      color: ordered[0].color,
      ring,
    });
  }

  return { corridors, singles };
}
