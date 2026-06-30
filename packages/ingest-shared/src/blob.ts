import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

// Blob store. Keys are SHA-256 of content so re-uploads dedupe automatically.
//
// When AWS S3 env vars are present, blobs are stored in the configured bucket
// under the `interview-assist/` prefix (so everything this product uploads —
// resumes etc. — lands in one folder). Otherwise it falls back to the local
// filesystem. `get()` reads from S3 first, then falls back to local so blobs
// written before S3 was configured still resolve.

export interface BlobStore {
  put(content: Buffer): Promise<{ key: string; sha256: string; bytes: number }>;
  get(key: string): Promise<Buffer>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, "../../..");

function blobRoot(): string {
  const raw = process.env.BLOB_ROOT ?? "./var/blobs";
  return path.isAbsolute(raw) ? raw : path.resolve(MONOREPO_ROOT, raw);
}

// All product uploads live under this single bucket folder.
const S3_PREFIX = "interview-assist/";

interface S3Config { region: string; bucket: string; accessKeyId: string; secretAccessKey: string }
function s3Config(): S3Config | null {
  const accessKeyId = process.env.AWS_S3_ACCESS_KEY;
  const secretAccessKey = process.env.AWS_S3_SECRET_KEY;
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_BUCKET_NAME;
  if (accessKeyId && secretAccessKey && region && bucket) return { region, bucket, accessKeyId, secretAccessKey };
  return null;
}

let _s3: S3Client | null = null;
function s3(cfg: S3Config): S3Client {
  if (!_s3) _s3 = new S3Client({ region: cfg.region, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  return _s3;
}

// Content-addressed key: <first2>/<sha256>. Always forward-slashed (S3-safe).
function keyFor(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}`;
}

async function localPut(content: Buffer, sha256: string): Promise<void> {
  const root = blobRoot();
  const key = keyFor(sha256);
  await mkdir(path.join(root, path.dirname(key)), { recursive: true });
  await writeFile(path.join(root, key), content);
}

export const blobStore: BlobStore = {
  async put(content) {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const key = keyFor(sha256);
    const cfg = s3Config();
    if (cfg) {
      await s3(cfg).send(new PutObjectCommand({ Bucket: cfg.bucket, Key: S3_PREFIX + key, Body: content }));
    } else {
      await localPut(content, sha256);
    }
    return { key, sha256, bytes: content.byteLength };
  },
  async get(key) {
    const cfg = s3Config();
    if (cfg) {
      try {
        const res = await s3(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: S3_PREFIX + key }));
        const bytes = await res.Body!.transformToByteArray();
        return Buffer.from(bytes);
      } catch {
        // Fall through to local — covers blobs written before S3 was enabled.
      }
    }
    return readFile(path.join(blobRoot(), key));
  },
};
