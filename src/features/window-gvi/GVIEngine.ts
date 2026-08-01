import {
  BuildingGviResult,
  FlatResult,
  FloorResult,
  RoomResult,
  WindowResult,
} from "./types";

// Pure rollup math: window -> room -> flat -> floor -> building, each level
// a simple average of the level below (per spec). Takes a flat list of
// WindowResult (from ResultStore) and groups it.

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function rollUpRooms(windowResults: WindowResult[]): RoomResult[] {
  const groups = new Map<string, WindowResult[]>();
  for (const w of windowResults) {
    const key = `${w.floor}::${w.flat}::${w.room}`;
    const group = groups.get(key) ?? [];
    group.push(w);
    groups.set(key, group);
  }
  return Array.from(groups.entries()).map(([key, windows]) => {
    const [, flat, room] = key.split("::");
    return {
      room,
      floor: windows[0].floor,
      flat,
      windowIds: windows.map((w) => w.windowId),
      averageGviPercent: average(windows.map((w) => w.averageGviPercent)),
    };
  });
}

export function rollUpFlats(roomResults: RoomResult[]): FlatResult[] {
  const groups = new Map<string, RoomResult[]>();
  for (const r of roomResults) {
    const key = `${r.floor}::${r.flat}`;
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  return Array.from(groups.entries()).map(([key, rooms]) => {
    const [, flat] = key.split("::");
    return {
      flat,
      floor: rooms[0].floor,
      roomIds: rooms.map((r) => r.room),
      averageGviPercent: average(rooms.map((r) => r.averageGviPercent)),
    };
  });
}

export function rollUpFloors(flatResults: FlatResult[]): FloorResult[] {
  const groups = new Map<number, FlatResult[]>();
  for (const f of flatResults) {
    const group = groups.get(f.floor) ?? [];
    group.push(f);
    groups.set(f.floor, group);
  }
  return Array.from(groups.entries())
    .map(([floor, flats]) => ({
      floor,
      flatIds: flats.map((f) => f.flat),
      averageGviPercent: average(flats.map((f) => f.averageGviPercent)),
    }))
    .sort((a, b) => a.floor - b.floor);
}

export function rollUpBuilding(windowResults: WindowResult[]): BuildingGviResult {
  const rooms = rollUpRooms(windowResults);
  const flats = rollUpFlats(rooms);
  const floors = rollUpFloors(flats);
  return {
    floors,
    averageGviPercent: average(floors.map((f) => f.averageGviPercent)),
  };
}
