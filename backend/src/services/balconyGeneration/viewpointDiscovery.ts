import { floorRepository } from "../../repositories/floorRepository";
import { viewpointRepository } from "../../repositories/viewpointRepository";
import { BalconyDirection } from "../../types";

export const BALCONY_DIRECTIONS: BalconyDirection[] = ["North", "South", "East", "West"];
export const FLATS_PER_DIRECTION = 3;

/**
 * Discovers every balcony/window slot for a building: its real floors (from
 * gv_floors, seeded 1-10 by the migration) x every direction x every flat
 * number, ensuring a gv_viewpoints row exists for each. Safe to call
 * repeatedly — existing viewpoints (and anything they've already captured)
 * are left untouched.
 */
export async function discoverViewpointsForBuilding(buildingId: string): Promise<string[]> {
  const floors = await floorRepository.listByBuilding(buildingId);
  const viewpointIds: string[] = [];

  for (const floor of floors) {
    for (const direction of BALCONY_DIRECTIONS) {
      for (let flat = 1; flat <= FLATS_PER_DIRECTION; flat++) {
        const viewpoint = await viewpointRepository.upsertSlot({
          buildingId,
          floorId: floor.id,
          direction,
          flatNumber: flat,
        });
        viewpointIds.push(viewpoint.id);
      }
    }
  }

  return viewpointIds;
}
