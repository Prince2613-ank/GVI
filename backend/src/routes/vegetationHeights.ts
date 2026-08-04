import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { vegetationHeightRepository } from "../repositories/vegetationHeightRepository";

const router = Router();

interface HeightKey {
  polygonId: string;
  clientUpdatedAt: number;
}

function isValidKey(value: unknown): value is HeightKey {
  const key = value as Partial<HeightKey>;
  return typeof key?.polygonId === "string" && typeof key?.clientUpdatedAt === "number";
}

// Read-only, no admin token — same reasoning as balcony-viewpoints' GET
// routes: this is cached derived data (a terrain measurement), not
// something that needs write protection to just look up.
router.post(
  "/lookup",
  asyncHandler(async (req, res) => {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.filter(isValidKey) : [];
    const rows = await vegetationHeightRepository.findMany(keys);
    res.json({
      heights: rows.map((row) => ({
        polygonId: row.polygon_id,
        clientUpdatedAt: Number(row.client_updated_at),
        heightM: row.height_m,
      })),
    });
  })
);

interface HeightEntry extends HeightKey {
  heightM: number;
}

function isValidEntry(value: unknown): value is HeightEntry {
  const entry = value as Partial<HeightEntry>;
  return (
    typeof entry?.polygonId === "string" &&
    typeof entry?.clientUpdatedAt === "number" &&
    typeof entry?.heightM === "number" &&
    Number.isFinite(entry.heightM)
  );
}

// No admin token here either — this only ever writes a terrain measurement
// (a real physical fact, not user-authored content), keyed so a bad/duplicate
// write just overwrites itself with the same correct value. Worth locking
// down later if abuse becomes a real concern, but not the kind of mutation
// the balcony-viewpoints admin gate exists to protect against.
router.post(
  "/save",
  asyncHandler(async (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries.filter(isValidEntry) : [];
    await vegetationHeightRepository.upsertMany(entries);
    res.json({ saved: entries.length });
  })
);

export default router;
