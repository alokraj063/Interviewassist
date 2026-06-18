// Thin fetch wrapper for calls to the backend API.
//
// Auth model (post-Phase 2):
// - Access token lives in memory only (set/cleared by AuthContext).
// - Refresh token is an httpOnly cookie scoped to /api/auth — never read by JS.
// - On a 401 with a cached access token, apiFetch transparently calls
//   /api/auth/refresh (cookie-based) once and retries; if that fails, it
//   clears the in-memory token and lets the caller see the 401 so routing
//   can redirect to sign-in.

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8787";

export function getApiBase(): string {
  return API_BASE;
}

export function getWsBase(): string {
  const fromEnv = (import.meta.env.VITE_WS_BASE_URL as string | undefined) ?? null;
  if (fromEnv) return fromEnv;
  const url = new URL(API_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

let accessToken: string | null = null;
let onTokenChange: ((token: string | null) => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
  onTokenChange?.(token);
}

export function getAccessToken(): string | null {
  return accessToken;
}

// Back-compat alias — callers that build WS/SSE URLs pulled the token via
// getStoredToken() when it lived in localStorage. The token now lives in
// memory; the name stays so we don't churn call sites.
export const getStoredToken = getAccessToken;

export function subscribeTokenChange(fn: (token: string | null) => void): () => void {
  onTokenChange = fn;
  return () => {
    if (onTokenChange === fn) onTokenChange = null;
  };
}

export interface ApiError extends Error {
  status: number;
  body?: unknown;
}

function makeError(status: number, body: unknown, message?: string): ApiError {
  const err = new Error(message ?? `HTTP ${status}`) as ApiError;
  err.status = status;
  err.body = body;
  return err;
}

let refreshInflight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { accessToken?: string };
      if (!body.accessToken) return false;
      setAccessToken(body.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown; auth?: boolean; _retry?: boolean },
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) headers.set("Content-Type", "application/json");
  if (init?.auth !== false && accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include",
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });

  if (res.status === 401 && init?.auth !== false && !init?._retry) {
    const ok = await refreshAccessToken();
    if (ok) return apiFetch<T>(path, { ...init, _retry: true });
    setAccessToken(null);
  }

  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw makeError(res.status, body);
  return body as T;
}

/** Attempt a silent refresh once on app load. Returns the user payload on success. */
export async function silentRefresh(): Promise<{ user: unknown; accessToken: string } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { accessToken: string; user: unknown };
    setAccessToken(body.accessToken);
    return body;
  } catch {
    return null;
  }
}
