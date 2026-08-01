import { Request, Response } from "express";
import { balconyGenerationService } from "../services/balconyGenerationService";
import { imageStorage } from "../services/storage";
import { ValidationError } from "../errors";
import { DEMO_BUILDING_ID } from "../config";

export const balconyGenerationController = {
  async listViewpoints(req: Request, res: Response): Promise<void> {
    const buildingId = (req.query.buildingId as string | undefined) ?? DEMO_BUILDING_ID;
    const floorId = req.query.floorId as string | undefined;
    const viewpoints = await balconyGenerationService.listViewpoints(buildingId, floorId);
    res.json({ viewpoints });
  },

  async getViewpoint(req: Request, res: Response): Promise<void> {
    const viewpoint = await balconyGenerationService.getViewpoint(req.params.id);
    res.json({ viewpoint });
  },

  async startGeneration(req: Request, res: Response): Promise<void> {
    const buildingId = req.body.buildingId ?? DEMO_BUILDING_ID;
    const result = await balconyGenerationService.startGeneration(buildingId);
    res.status(202).json(result);
  },

  async getProgress(req: Request, res: Response): Promise<void> {
    const buildingId = (req.query.buildingId as string | undefined) ?? DEMO_BUILDING_ID;
    const progress = await balconyGenerationService.getProgress(buildingId);
    res.json(progress);
  },

  async pause(_req: Request, res: Response): Promise<void> {
    balconyGenerationService.pause();
    res.json({ isPaused: true });
  },

  async resume(_req: Request, res: Response): Promise<void> {
    balconyGenerationService.resume();
    res.json({ isPaused: false });
  },

  async cancel(_req: Request, res: Response): Promise<void> {
    const cancelledCount = await balconyGenerationService.cancel();
    res.json({ cancelledCount });
  },

  async retryFailed(_req: Request, res: Response): Promise<void> {
    const requeuedCount = await balconyGenerationService.retryFailed();
    res.json({ requeuedCount });
  },

  async regenerateViewpoint(req: Request, res: Response): Promise<void> {
    const job = await balconyGenerationService.regenerateOne(req.params.id);
    res.status(202).json({ job });
  },

  async manualCapture(req: Request, res: Response): Promise<void> {
    const {
      buildingId,
      floorNumber,
      direction,
      flatNumber,
      longitude,
      latitude,
      height,
      heading,
      pitch,
      roll,
      previewImageDataUrl,
      maskImageDataUrl,
      imageWidth,
      imageHeight,
      gviScore,
      greenPixels,
      greyPixels,
      totalPixels,
    } = req.body;

    if (
      floorNumber === undefined ||
      !direction ||
      flatNumber === undefined ||
      longitude === undefined ||
      latitude === undefined ||
      height === undefined ||
      !previewImageDataUrl
    ) {
      throw new ValidationError(
        "floorNumber, direction, flatNumber, longitude, latitude, height and previewImageDataUrl are required"
      );
    }

    const result = await balconyGenerationService.manualCapture({
      buildingId,
      floorNumber,
      direction,
      flatNumber,
      longitude,
      latitude,
      height,
      heading: heading ?? 0,
      pitch: pitch ?? 0,
      roll: roll ?? 0,
      previewImageDataUrl,
      maskImageDataUrl,
      imageWidth: imageWidth ?? 0,
      imageHeight: imageHeight ?? 0,
      gviScore: gviScore ?? 0,
      greenPixels: greenPixels ?? 0,
      greyPixels: greyPixels ?? 0,
      totalPixels: totalPixels ?? 0,
    });
    res.status(201).json(result);
  },

  async resetSlots(req: Request, res: Response): Promise<void> {
    const { slots } = req.body;
    if (!Array.isArray(slots)) throw new ValidationError("slots must be an array");
    const result = await balconyGenerationService.resetSlots(slots, req.body.buildingId);
    res.json(result);
  },

  async importPositions(req: Request, res: Response): Promise<void> {
    const { positions } = req.body;
    if (!Array.isArray(positions)) throw new ValidationError("positions must be an array");
    const result = await balconyGenerationService.importPositions(positions, req.body.buildingId);
    res.json(result);
  },

  async regenerateFloor(req: Request, res: Response): Promise<void> {
    const enqueuedCount = await balconyGenerationService.regenerateFloorById(req.params.floorId);
    res.status(202).json({ enqueuedCount });
  },

  async getMedia(req: Request, res: Response): Promise<void> {
    const storedPath = (req.params[0] as string) ?? "";
    if (!storedPath) throw new ValidationError("Missing media path");
    const file = await imageStorage.read(storedPath);
    if (!file) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(file.buffer);
  },
};
