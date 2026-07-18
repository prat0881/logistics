import { Injectable } from "@nestjs/common";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STORAGE = Symbol("STORAGE");

export interface StorageService {
  put(key: string, data: Buffer): Promise<void>;
  path(key: string): string;
}

// Local disk in dev → S3-compatible object store later (§8.4). UPLOADS_DIR read at
// CALL TIME (ConfigModule loads .env at init; a top-level const would capture stale env).
@Injectable()
export class LocalDiskStorage implements StorageService {
  private root(): string {
    return process.env.UPLOADS_DIR ?? join(process.cwd(), "uploads");
  }
  async put(key: string, data: Buffer): Promise<void> {
    const full = join(this.root(), key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  path(key: string): string {
    return join(this.root(), key);
  }
}
