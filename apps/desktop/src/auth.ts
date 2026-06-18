// Electron main-process auth manager.
//
// Persists a rotating refresh token (encrypted via safeStorage) at
// <userData>/session.bin, and holds the current access token in memory.
// Renderer talks to this via IPC — it never sees the refresh token.
//
// Contract:
//   - signIn(email, password) → { user }
//   - signOut()               → revokes + wipes
//   - getAccessToken()        → string (auto-refreshes if expired/missing)
//   - whoAmI()                → { user, apiBaseUrl, wsBaseUrl } | null

 
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiBaseUrl, wsBaseUrl } from "./config.js";

declare const require: NodeRequire;
const electron: typeof import("electron") = require("electron");
const { app, safeStorage } = electron;

export { wsBaseUrl };

export interface DesktopUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  org: { id: string; name: string };
}

interface Session {
  refreshToken: string;
  user: DesktopUser;
}

let accessToken: string | null = null;
let accessTokenExp = 0; // ms epoch
let session: Session | null = null;
let sessionFilePath = "";

function decodeExp(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function loadSession(): Promise<void> {
  sessionFilePath = path.join(app.getPath("userData"), "session.bin");
  try {
    const raw = await readFile(sessionFilePath);
    if (!safeStorage.isEncryptionAvailable()) return;
    const decrypted = safeStorage.decryptString(raw);
    session = JSON.parse(decrypted) as Session;
  } catch {
    // No session yet — that's fine.
  }
}

async function persistSession(): Promise<void> {
  if (!session) {
    try { await unlink(sessionFilePath); } catch { /* ignore */ }
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("safeStorage unavailable — session will not persist across launches");
    return;
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(session));
  await writeFile(sessionFilePath, encrypted);
}

async function callAuth<T>(path: string, body: Record<string, unknown>, refreshToken?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Client": "desktop",
  };
  if (refreshToken) headers["X-Refresh-Token"] = refreshToken;
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = new Error(`auth_error: ${res.status} ${JSON.stringify(json)}`);
    (err as Error & { status?: number; body?: unknown }).status = res.status;
    (err as Error & { status?: number; body?: unknown }).body = json;
    throw err;
  }
  return json as T;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: DesktopUser;
}

export async function initAuth(): Promise<void> {
  await loadSession();
  if (session) {
    // Try a silent refresh; if it fails, drop the stored session.
    try {
      await refresh();
    } catch {
      session = null;
      await persistSession();
    }
  }
}

export async function signIn(email: string, password: string): Promise<{ user: DesktopUser }> {
  const res = await callAuth<LoginResponse>("/api/auth/login", { email, password });
  accessToken = res.accessToken;
  accessTokenExp = decodeExp(res.accessToken);
  session = { refreshToken: res.refreshToken, user: res.user };
  await persistSession();
  return { user: res.user };
}

async function refresh(): Promise<void> {
  if (!session) throw new Error("no_session");
  const res = await callAuth<LoginResponse>("/api/auth/refresh", {}, session.refreshToken);
  accessToken = res.accessToken;
  accessTokenExp = decodeExp(res.accessToken);
  session = { refreshToken: res.refreshToken, user: res.user };
  await persistSession();
}

export async function getAccessToken(): Promise<string> {
  if (!session) throw new Error("not_signed_in");
  // Refresh 30s before expiry to avoid races in flight.
  const now = Date.now();
  if (!accessToken || now + 30_000 >= accessTokenExp) {
    await refresh();
  }
  if (!accessToken) throw new Error("no_access_token");
  return accessToken;
}

export async function signOut(): Promise<void> {
  const rt = session?.refreshToken;
  accessToken = null;
  accessTokenExp = 0;
  session = null;
  await persistSession();
  if (rt) {
    try {
      await callAuth("/api/auth/logout", {}, rt);
    } catch {
      // best-effort — local session is already wiped.
    }
  }
}

export function whoAmI(): { user: DesktopUser; apiBaseUrl: string; wsBaseUrl: string } | null {
  if (!session) return null;
  return { user: session.user, apiBaseUrl: apiBaseUrl(), wsBaseUrl: wsBaseUrl() };
}
