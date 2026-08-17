import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";

/**
 * Object-storage abstraction for balcony preview/mask images. The local
 * filesystem adapter is dev-only — Render's web service disk is ephemeral
 * and gets wiped on every deploy, so anything saved there disappears the
 * next time this service redeploys. SupabaseStorage is the durable adapter
 * used in production; S3, Azure Blob, GCS and MinIO would fit this same
 * interface without touching any caller, they'd just need their own adapter
 * class swapped in here.
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

// Uses the service-role key (server-side only, never exposed to the
// frontend) so it can read/write the bucket regardless of its RLS policies.
// Stored paths are bucket-relative object keys — the same shape
// LocalFilesystemStorage returns — so gv_captured_images.image_path etc.
// need no format change, and getMedia's proxy route keeps working as-is.
class SupabaseStorage implements ImageStorage {
  private readonly client: ReturnType<typeof createClient>;

  constructor(
    supabaseUrl: string,
    serviceRoleKey: string,
    private readonly bucket: string
  ) {
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  async save(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const extension = CONTENT_TYPE_EXTENSION[contentType] ?? "bin";
    const objectKey = path.posix.join(key, `${randomUUID()}.${extension}`);
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(objectKey, buffer, { contentType, upsert: false });
    if (error) throw new Error(`Supabase storage upload failed: ${error.message}`);
    return objectKey;
  }

  async read(storedPath: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    const { data, error } = await this.client.storage.from(this.bucket).download(storedPath);
    if (error || !data) return null;
    const buffer = Buffer.from(await data.arrayBuffer());
    const extension = path.extname(storedPath).toLowerCase();
    const contentType = extension === ".png" ? "image/png" : "image/jpeg";
    return { buffer, contentType };
  }
}

function createImageStorage(): ImageStorage {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "balcony-images";

  if (supabaseUrl && serviceRoleKey) {
    return new SupabaseStorage(supabaseUrl, serviceRoleKey, bucket);
  }

  const storageRoot = process.env.BALCONY_STORAGE_DIR
    ? path.resolve(process.env.BALCONY_STORAGE_DIR)
    : path.resolve(process.cwd(), "storage");
  return new LocalFilesystemStorage(storageRoot);
}

export const imageStorage: ImageStorage = createImageStorage();
