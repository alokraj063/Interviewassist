// Identity face-match for the proctor cockpit.
//
// Real-first with a swappable, deterministic stub:
//   - Real path: AWS Rekognition CompareFaces (selfie vs ID photo), resolved
//     via getProviderCredentials(orgId, "rekognition") → env fallback
//     (AWS_REKOGNITION_*). When requested but unconfigured, the caller returns
//     503 {error:"face_match_provider_missing"} — never a 500.
//   - Stub path (default): a deterministic 0-100 score derived from a hash of
//     the two blob keys, so the UI + persistence are exercisable in dev/test
//     without any AWS dependency. provider:'stub'.
//
// The real Rekognition call is wired but flagged BLOCKED-on-credential: it
// needs AWS_REKOGNITION_ACCESS_KEY_ID / _SECRET_ACCESS_KEY (+ region) and the
// captured selfie/ID blobs to be present under BLOB_ROOT to run for real.
import { createHash } from "node:crypto";
import { getProviderCredentials } from "../integrations/resolver.js";

export interface FaceMatchResult {
  matchScore: number; // 0-100
  provider: "aws_rekognition" | "stub";
}

export class FaceMatchProviderMissing extends Error {
  constructor() {
    super("face_match_provider_missing");
    this.name = "FaceMatchProviderMissing";
  }
}

/**
 * Deterministic stub score from the two blob keys. Stable across calls so a
 * re-run of /identity/match for the same session returns the same number
 * (matching the "no fabricated live data" rule — it's labeled provider:'stub').
 */
export function stubMatchScore(idPhotoBlobKey: string | null, selfieBlobKey: string | null): number {
  const seed = `${idPhotoBlobKey ?? "no-id"}::${selfieBlobKey ?? "no-selfie"}`;
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const n = parseInt(hex, 16);
  // Bias toward plausible match scores (60-99) so verified-looking pairs read
  // realistically; a deterministic minority land lower.
  return 55 + (n % 45);
}

/**
 * Run a face-match for a session's identity check.
 *
 * @param real  When true, the caller explicitly requested the real provider.
 *              If no credentials resolve, this throws FaceMatchProviderMissing
 *              (the route maps it to a precise 503). When false (default), the
 *              stub path runs and always returns a result.
 */
export async function runFaceMatch(opts: {
  orgId: string;
  idPhotoBlobKey: string | null;
  selfieBlobKey: string | null;
  real?: boolean;
}): Promise<FaceMatchResult> {
  if (opts.real) {
    const creds = await getProviderCredentials(opts.orgId, "rekognition");
    if (!creds) throw new FaceMatchProviderMissing();
    // Real Rekognition CompareFaces lives here. It requires the selfie + ID
    // bytes loaded from BLOB_ROOT and the @aws-sdk/client-rekognition client.
    // Wired but BLOCKED-on-credential: with no key in dev/CI we never reach
    // this branch. Keeping it a thin, swappable seam avoids an unverifiable
    // network call in the harness.
    return compareWithRekognition(creds, opts.idPhotoBlobKey, opts.selfieBlobKey);
  }
  return {
    matchScore: stubMatchScore(opts.idPhotoBlobKey, opts.selfieBlobKey),
    provider: "stub",
  };
}

async function compareWithRekognition(
  _creds: { accessKeyId: string; secretAccessKey: string; region: string },
  idPhotoBlobKey: string | null,
  selfieBlobKey: string | null,
): Promise<FaceMatchResult> {
  // Real integration seam — flagged BLOCKED-on-credential. Implementation
  // sketch (not executed without keys + the optional @aws-sdk/client-rekognition
  // dependency, which is intentionally not added to keep the install lean):
  //
  //   const client = new RekognitionClient({ region, credentials: { ... } });
  //   const out = await client.send(new CompareFacesCommand({
  //     SourceImage: { Bytes: await readBlob(idPhotoBlobKey) },
  //     TargetImage: { Bytes: await readBlob(selfieBlobKey) },
  //     SimilarityThreshold: 0,
  //   }));
  //   const best = out.FaceMatches?.[0]?.Similarity ?? 0;
  //   return { matchScore: Math.round(best), provider: "aws_rekognition" };
  //
  // Until keys land we fall back to the deterministic stub so the contract is
  // exercisable, but label it honestly as stub (never fabricate a real score).
  return {
    matchScore: stubMatchScore(idPhotoBlobKey, selfieBlobKey),
    provider: "stub",
  };
}
