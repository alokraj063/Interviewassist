// Thin wrapper over Vapi's REST API. We deliberately don't depend on
// @vapi-ai/server-sdk so we can upgrade independently and avoid a heavy dep.
//
// Auth: pulls the apiKey from the AsyncLocalStorage Vapi context set by
// `withVapiContext()` in route handlers (per-tenant credential, resolved via
// integrations.resolver). Falls back to env.VAPI_API_KEY for callers that
// run outside a context (jobs, scripts).
import { env } from "../env.js";
import { currentVapiContext } from "./context.js";

export class VapiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "VapiError";
  }
}

function apiKey(): string {
  const ctxKey = currentVapiContext()?.apiKey;
  if (ctxKey) return ctxKey;
  if (env.VAPI_API_KEY) return env.VAPI_API_KEY;
  throw new VapiError("VAPI_API_KEY is not configured", 500, null);
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${env.VAPI_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json: unknown = text ? safeParse(text) : null;
  if (!res.ok) {
    throw new VapiError(
      `Vapi ${method} ${path} failed (${res.status})`,
      res.status,
      json ?? text,
    );
  }
  return json as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// --- Assistants ---

export interface VapiAssistant {
  id: string;
  name?: string;
  [k: string]: unknown;
}

export async function createAssistant(payload: Record<string, unknown>): Promise<VapiAssistant> {
  return request<VapiAssistant>("POST", "/assistant", payload);
}

export async function updateAssistant(
  assistantId: string,
  payload: Record<string, unknown>,
): Promise<VapiAssistant> {
  return request<VapiAssistant>("PATCH", `/assistant/${assistantId}`, payload);
}

export async function deleteAssistant(assistantId: string): Promise<void> {
  await request<unknown>("DELETE", `/assistant/${assistantId}`);
}

// --- Phone numbers ---

export interface VapiPhoneNumber {
  id: string;
  number?: string;
  assistantId?: string | null;
  [k: string]: unknown;
}

// Vapi retired POST /phone-number/buy (returns 410 Gone). Purchases now go
// through the unified POST /phone-number with a provider discriminator;
// `vapi`-provider purchases take optional `numberDesiredAreaCode` (3+ digits).
export async function buyPhoneNumber(params: {
  areaCode?: string;
}): Promise<VapiPhoneNumber> {
  const body: Record<string, unknown> = { provider: "vapi" };
  if (params.areaCode) body.numberDesiredAreaCode = params.areaCode;
  return request<VapiPhoneNumber>("POST", "/phone-number", body);
}

export async function attachPhoneToAssistant(
  phoneId: string,
  assistantId: string,
): Promise<VapiPhoneNumber> {
  return request<VapiPhoneNumber>("PATCH", `/phone-number/${phoneId}`, { assistantId });
}

export async function getPhoneNumber(phoneId: string): Promise<VapiPhoneNumber> {
  return request<VapiPhoneNumber>("GET", `/phone-number/${phoneId}`);
}

// --- Voices (listing voices available through Vapi's aggregated voice catalog) ---

export interface VapiVoiceRecord {
  provider: string;
  voiceId: string;
  name?: string;
  language?: string;
  gender?: string;
  accent?: string;
  previewUrl?: string;
}

// Vapi's voice catalog is partitioned by provider — `/voice-library` without
// a provider returns 400. We fan out across the providers we actually use and
// merge. Vapi returns `providerId` (not `voiceId`); remap to match our schema.
const VOICE_PROVIDERS = ["11labs", "vapi", "cartesia"] as const;

type VapiVoiceRaw = {
  id: string;
  provider: string;
  providerId?: string;
  slug?: string;
  name?: string;
  gender?: string;
  accent?: string;
  language?: string;
  previewUrl?: string;
};

export async function listVoices(): Promise<VapiVoiceRecord[]> {
  const results = await Promise.allSettled(
    VOICE_PROVIDERS.map((p) => request<unknown>("GET", `/voice-library/${p}`)),
  );
  const out: VapiVoiceRecord[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const arr = Array.isArray(r.value)
      ? (r.value as VapiVoiceRaw[])
      : r.value && typeof r.value === "object" && "voices" in r.value
        ? ((r.value as { voices: VapiVoiceRaw[] }).voices ?? [])
        : [];
    for (const v of arr) {
      const voiceId = v.providerId ?? v.slug ?? v.id;
      if (!voiceId) continue;
      out.push({
        provider: v.provider,
        voiceId,
        name: v.name ?? voiceId,
        language: v.language,
        gender: v.gender,
        accent: v.accent,
        previewUrl: v.previewUrl,
      });
    }
  }
  return out;
}

// --- Files (Vapi-hosted KB documents; referenced by query tools) ---

export interface VapiFile {
  id: string;
  name?: string;
  mimetype?: string;
  bytes?: number;
  [k: string]: unknown;
}

// Vapi's POST /file is multipart/form-data. We build the body manually so we
// don't pull a formdata lib in just for this.
export async function uploadFile(
  buffer: Buffer,
  filename: string,
  mime: string,
): Promise<VapiFile> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer so the Blob type sees a plain ArrayBuffer
  // (not SharedArrayBuffer, which DOM types reject).
  const ab = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(ab).set(buffer);
  const blob = new Blob([ab], { type: mime });
  form.append("file", blob, filename);

  const res = await fetch(`${env.VAPI_API_BASE}/file`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  const text = await res.text();
  const json = text ? safeParse(text) : null;
  if (!res.ok) {
    throw new VapiError(`Vapi POST /file failed (${res.status})`, res.status, json ?? text);
  }
  return json as VapiFile;
}

export async function deleteFile(fileId: string): Promise<void> {
  await request<unknown>("DELETE", `/file/${fileId}`);
}

// --- Tools (function + query tools attached to an assistant's model.toolIds) ---

export interface VapiTool {
  id: string;
  type: string;
  [k: string]: unknown;
}

export async function createTool(payload: Record<string, unknown>): Promise<VapiTool> {
  return request<VapiTool>("POST", "/tool", payload);
}

export async function updateTool(
  toolId: string,
  payload: Record<string, unknown>,
): Promise<VapiTool> {
  return request<VapiTool>("PATCH", `/tool/${toolId}`, payload);
}

export async function deleteTool(toolId: string): Promise<void> {
  await request<unknown>("DELETE", `/tool/${toolId}`);
}

// --- Squads (multi-assistant orchestration; used for triage warm transfer) ---

export interface VapiSquad {
  id: string;
  name?: string;
  members?: Array<{ assistantId: string; assistantOverrides?: Record<string, unknown> }>;
  [k: string]: unknown;
}

export async function createSquad(payload: Record<string, unknown>): Promise<VapiSquad> {
  return request<VapiSquad>("POST", "/squad", payload);
}

export async function updateSquad(
  squadId: string,
  payload: Record<string, unknown>,
): Promise<VapiSquad> {
  return request<VapiSquad>("PATCH", `/squad/${squadId}`, payload);
}

export async function deleteSquad(squadId: string): Promise<void> {
  await request<unknown>("DELETE", `/squad/${squadId}`);
}

// --- Calls (mid-call control: warm transfer, switch squad member, end) ---

// Vapi exposes mid-call control via PATCH /call/:id with provider-specific
// directives. Documented options:
//   { transfer: { destination: { type: 'number'|'assistant'|'sip', ... } } }
//   { control: { type: 'end-call' } }
// Keep this typed loosely so we can iterate without redeploying a SDK shim.
export async function patchCall(
  callId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await request<unknown>("PATCH", `/call/${callId}`, body);
}
