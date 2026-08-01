import { Router } from "express";
import { requireAdminToken } from "../middleware/adminAuth";
import { asyncHandler } from "../middleware/asyncHandler";
import { balconyGenerationController } from "../controllers/balconyGenerationController";

const router = Router();

router.get("/viewpoints", asyncHandler(balconyGenerationController.listViewpoints));
router.get("/viewpoint/:id", asyncHandler(balconyGenerationController.getViewpoint));
router.get("/progress", asyncHandler(balconyGenerationController.getProgress));

router.post("/start-generation", requireAdminToken, asyncHandler(balconyGenerationController.startGeneration));
router.post("/pause", requireAdminToken, asyncHandler(balconyGenerationController.pause));
router.post("/resume", requireAdminToken, asyncHandler(balconyGenerationController.resume));
router.post("/cancel", requireAdminToken, asyncHandler(balconyGenerationController.cancel));
router.post("/retry-failed", requireAdminToken, asyncHandler(balconyGenerationController.retryFailed));
router.post("/manual-capture", requireAdminToken, asyncHandler(balconyGenerationController.manualCapture));
router.post("/import-positions", requireAdminToken, asyncHandler(balconyGenerationController.importPositions));
router.post("/reset-slots", requireAdminToken, asyncHandler(balconyGenerationController.resetSlots));
router.post("/regenerate/:id", requireAdminToken, asyncHandler(balconyGenerationController.regenerateViewpoint));
router.post("/regenerate-floor/:floorId", requireAdminToken, asyncHandler(balconyGenerationController.regenerateFloor));

export default router;
