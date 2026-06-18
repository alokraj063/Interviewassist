import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local-filesystem blob store. Keys are SHA-256 of content so re-uploads
// dedupe automatically. Swap with S3 behind the same interface in prod.

export interface BlobStore {
  put(content: Buffer): Promise<{ key: string; sha256: string; bytes: number }>;
  get(key: string): Promise<Buffer>;
}

// Resolve the blob root relative to the monorepo root (not the caller's cwd),
// so the API (running in apps/api) and the worker (running in apps/worker)
// agree on the same directory when a relative BLOB_ROOT is used.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, "../../..");

function blobRoot(): string {
  const raw = process.env.BLOB_ROOT ?? "./var/blobs";
  return path.isAbsolute(raw) ? raw : path.resolve(MONOREPO_ROOT, raw);
}

export const blobStore: BlobStore = {
  async put(content) {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const root = blobRoot();
    const dir = path.join(root, sha256.slice(0, 2));
    const key = path.join(sha256.slice(0, 2), sha256);
    const fullPath = path.join(root, key);
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content);
    return { key, sha256, bytes: content.byteLength };
  },
  async get(key) {
    return readFile(path.join(blobRoot(), key));
  },
};
