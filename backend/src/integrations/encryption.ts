// AES-256-GCM at-rest encryption for per-tenant integration credentials.
//
// On-disk layout in tenant_integrations.ciphertext:
//   bytes [0..12)   = AES-GCM nonce (IV)
//   bytes [12..N-16) = ciphertext
//   bytes [N-16..N) = AES-GCM auth tag
//
// The master key is env.INTEGRATIONS_KEK (32 bytes, base64). Plaintext is the
// JSON-stringified TenantIntegrationSecret for that provider.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.js";

const NONCE_LEN = 12;
const TAG_LEN = 16;

export class CredentialsEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsEncryptionError";
  }
}

function key(): Buffer {
  if (!env.INTEGRATIONS_KEK) {
    throw new CredentialsEncryptionError(
      "INTEGRATIONS_KEK is not set; cannot encrypt or decrypt tenant credentials",
    );
  }
  const buf = Buffer.from(env.INTEGRATIONS_KEK, "base64");
  if (buf.length !== 32) {
    throw new CredentialsEncryptionError("INTEGRATIONS_KEK must decode to 32 bytes");
  }
  return buf;
}

export function encryptSecret(plaintext: object): Buffer {
  const json = Buffer.from(JSON.stringify(plaintext), "utf8");
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const ct = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

export function decryptSecret<T = unknown>(blob: Buffer): T {
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new CredentialsEncryptionError("ciphertext blob too short");
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key(), nonce);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString("utf8")) as T;
  } catch (err) {
    throw new CredentialsEncryptionError(
      `failed to decrypt tenant credentials: ${(err as Error).message}`,
    );
  }
}

// Provider-specific credential shapes. Keep these intentionally narrow — the
// resolver returns one of these typed unions, not a raw object.
export interface VapiSecret {
  provider: "vapi";
  apiKey: string;
  publicKey?: string;
  webhookSecret?: string;
}
export interface DeepgramSecret {
  provider: "deepgram";
  apiKey: string;
}
export interface SarvamSecret {
  provider: "sarvam";
  apiSubscriptionKey: string;
}
export interface ShunyaSecret {
  provider: "shunya";
  apiKey: string;
}
// AWS Rekognition for proctor identity face-match (CompareFaces).
export interface RekognitionSecret {
  provider: "rekognition";
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export type TenantIntegrationSecret =
  | VapiSecret
  | DeepgramSecret
  | SarvamSecret
  | ShunyaSecret
  | RekognitionSecret;
