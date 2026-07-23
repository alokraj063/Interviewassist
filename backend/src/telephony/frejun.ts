// FreJun REST client — the ONLY module that talks to api.frejun.com.
//
// Scope: we use FreJun to PLACE, RECEIVE and RECORD calls. We deliberately do
// NOT consume its `call_transcript` / `ai_insights` fields — this service
// transcribes with Deepgram and evaluates with OpenAI. (Verified against the
// live account on 2026-07-22: both fields were null on every row anyway.)
//
// Auth quirk discovered by probing the live API:
//   • `Authorization: Api-Key <key>`  works for /integrations/calls/ and
//     /integrations/call-to-voip/.
//   • The /integrations/webhooks/ family rejects the API key outright
//     (401 "Given token is not valid") — it wants a real OAuth access token.
//     So webhook registration is done in the FreJun dashboard UI, not here.
//     Those helpers are intentionally absent until OAuth creds arrive.
import { env } from "../env.js";

export class FrejunError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `FreJun API error ${status}`);
    this.name = "FrejunError";
  }
}

/** False when no API key is configured — callers should 503, never throw. */
export function isFrejunConfigured(): boolean {
  return Boolean(env.FREJUN_API_KEY);
}

async function frejunFetch<T>(
  path: string,
  init: { method?: string; json?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  if (!env.FREJUN_API_KEY) throw new FrejunError(503, null, "frejun_not_configured");

  const url = new URL(`${env.FREJUN_API_BASE.replace(/\/$/, "")}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      // NOTE: the scheme is literally "Api-Key", not "Bearer".
      Authorization: `Api-Key ${env.FREJUN_API_KEY}`,
      Accept: "application/json",
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // FreJun serves HTML on 404 — keep the raw text for the error message.
  }

  if (!res.ok) {
    const msg = (body as { message?: string } | null)?.message;
    throw new FrejunError(res.status, body, msg ? `FreJun: ${msg}` : undefined);
  }
  return body as T;
}

// ─── Call logs ───────────────────────────────────────────────────────────────

/**
 * One row of GET /integrations/calls/. Field names + types verified against
 * the live account — do not "correct" them against the docs, which differ.
 */
export interface FrejunCallLog {
  id: number;
  /** Short hash (e.g. "Xp8l2M6"), NOT a UUID. This is the id webhooks carry. */
  call_id: string;
  /** Free metadata slots. We put our interview id in `transaction_id` and the
   *  OL demand id in `job_id` — both are filterable on this endpoint, which is
   *  what makes webhook-miss reconciliation possible. */
  transaction_id: string | null;
  job_id: string | null;
  candidate_id: string | null;
  candidate_number: string | null;
  candidate_name: string | null;
  creator_number: string | null;
  virtual_number: string | null;
  link: string | null;
  status: string;
  call_start_time: string | null;
  call_end_time: string | null;
  /** MINUTES (float), measured answer→end — not start→end. */
  call_duration: number | null;
  call_type: "incoming" | "outgoing";
  /** The FreJun user's email. */
  recruiter: string | null;
  call_reason: string | null;
  call_outcome: string | null;
  recruiter_notes: string | null;
  /** Signature-signed and therefore EXPIRING — copy the bytes, not the URL. */
  recording_url: string | null;
  campaign_name: string | null;
  cost: string | null;
}

export interface FrejunPage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface ListCallsFilters {
  call_id?: string;
  candidate_number?: string;
  transaction_id?: string;
  job_id?: string;
  recruiter_email?: string;
  /** "DD/MM/YY H:M:S" — FreJun's format, not ISO. */
  date?: string;
  date_end?: string;
  page?: number;
}

export function listCalls(filters: ListCallsFilters = {}): Promise<FrejunPage<FrejunCallLog>> {
  return frejunFetch<FrejunPage<FrejunCallLog>>("/integrations/calls/", { query: { ...filters } });
}

/** Look a call up by the interview id we stamped into `transaction_id`. */
export async function findCallByTransactionId(transactionId: string): Promise<FrejunCallLog | null> {
  const page = await listCalls({ transaction_id: transactionId });
  return page.results[0] ?? null;
}

/** Look a call up by FreJun's own short id. */
export async function findCallById(callId: string): Promise<FrejunCallLog | null> {
  const page = await listCalls({ call_id: callId });
  return page.results[0] ?? null;
}

// ─── Placing a call ──────────────────────────────────────────────────────────

export interface CallToVoipInput {
  /** FreJun user placing the call. Format unverified — see telephony/agents.ts. */
  agentId: string;
  /** Destination. FreJun currently accepts Indian numbers only. */
  dstnNumber: string;
  candidateName?: string;
  virtualNumber?: string;
  /** Our ia_interviews id. Comes back on the call log + webhooks. */
  transactionId?: string;
  /** The OL demand (jobPosting) id. */
  jobId?: string;
  candidateId?: string;
}

/**
 * POST /integrations/call-to-voip/ — rings the CANDIDATE first, then connects
 * the recruiter's registered softphone. The recruiter must already be logged
 * into a softphone (browser SDK / extension) or the call cannot complete.
 *
 * Verified required params: `agent_id`, `dstn_number`.
 */
export async function callToVoip(input: CallToVoipInput): Promise<{ callId: string; raw: unknown }> {
  const payload: Record<string, unknown> = {
    agent_id: input.agentId,
    dstn_number: input.dstnNumber,
  };
  if (input.candidateName) payload.candidate_name = input.candidateName;
  const virtual = input.virtualNumber ?? env.FREJUN_VIRTUAL_NUMBER;
  if (virtual) payload.virtual_number = virtual;
  if (input.transactionId) payload.transaction_id = input.transactionId;
  if (input.jobId) payload.job_id = input.jobId;
  if (input.candidateId) payload.candidate_id = input.candidateId;

  const res = await frejunFetch<{ callId?: string; call_id?: string }>("/integrations/call-to-voip/", {
    method: "POST",
    json: payload,
  });
  // Docs say `callId`; the log endpoint uses `call_id`. Accept either.
  const callId = res.callId ?? res.call_id;
  if (!callId) throw new FrejunError(502, res, "FreJun did not return a call id");
  return { callId, raw: res };
}

// ─── Recordings ──────────────────────────────────────────────────────────────

/**
 * Download a recording. The URL carries a `?signature=` and will stop working,
 * so callers must persist the BYTES (blobStore) rather than the link.
 */
export async function fetchRecording(recordingUrl: string): Promise<Buffer> {
  const res = await fetch(recordingUrl, {
    headers: { Authorization: `Api-Key ${env.FREJUN_API_KEY ?? ""}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new FrejunError(res.status, null, `recording download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
