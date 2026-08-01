import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { balconyGenerationController } from "../controllers/balconyGenerationController";

const router = Router();

// Wildcard captures the full nested storage key (previews/<uuid>/<file>.jpg).
router.get("/*", asyncHandler(balconyGenerationController.getMedia));

export default router;
