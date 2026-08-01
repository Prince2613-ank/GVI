import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";

/**
 * Object-storage abstraction for balcony preview/mask images. Only the local
 * filesystem adapter is implemented — S3, Azure Blob, GCS and MinIO all fit
 * this same interface without touching any caller, they just need their own
 * adapter class swapped in here.
 */
export interface ImageStorage {
  save(key: string, buffer: Buffer, contentType: string): Promise<string>;
  read(storedPath: string): Promise<{ buffer: Buffer; contentType: string } | null>;
}

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

class LocalFilesystemStorage implements ImageStorage {
  constructor(private readonly rootDir: string) {}

  async save(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const extension = CONTENT_TYPE_EXTENSION[contentType] ?? "bin";
    const relativePath = path.posix.join(key, `${randomUUID()}.${extension}`);
    const absolutePath = path.join(this.rootDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);
    return relativePath;
  }

  async read(storedPath: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    const absolutePath = path.join(this.rootDir, storedPath);
    if (!absolutePath.startsWith(path.resolve(this.rootDir))) return null;
    try {
      const buffer = await fs.readFile(absolutePath);
      const extension = path.extname(absolutePath).toLowerCase();
      const contentType = extension === ".png" ? "image/png" : "image/jpeg";
      return { buffer, contentType };
    } catch {
      return null;
    }
  }
}

const STORAGE_ROOT = process.env.BALCONY_STORAGE_DIR
  ? path.resolve(process.env.BALCONY_STORAGE_DIR)
  : path.resolve(process.cwd(), "storage");

export const imageStorage: ImageStorage = new LocalFilesystemStorage(STORAGE_ROOT);
