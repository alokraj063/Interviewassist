import {
  AUDIO_CHANNEL_RECRUITER,
  AUDIO_CHANNEL_CANDIDATE,
  AUDIO_FRAME_BYTES,
} from "@j2w/shared-types";
import workletUrl from "./audio-worklet.js?url";

interface ChannelState {
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
  bytesSent: number;
}

interface CallState {
  callId: string;
  ws: WebSocket;
  agent: ChannelState | null;
  customer: ChannelState | null;
  startedAt: number;
  durationTimer: number;
}

let current: CallState | null = null;
let agentWs: WebSocket | null = null;
let apiBaseUrl = "http://localhost:8787";
let wsBaseUrl = "ws://localhost:8787";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// Login view
const loginView = $<HTMLDivElement>("#loginView");
const loginForm = $<HTMLFormElement>("#loginForm");
const loginEmail = $<HTMLInputElement>("#loginEmail");
const loginPassword = $<HTMLInputElement>("#loginPassword");
const loginBtn = $<HTMLButtonElement>("#loginBtn");
const loginError = $<HTMLDivElement>("#loginError");

// App view
const appView = $<HTMLDivElement>("#appView");
const userAvatar = $<HTMLSpanElement>("#userAvatar");
const userName = $<HTMLDivElement>("#userName");
const userEmail = $<HTMLDivElement>("#userEmail");
const signOutBtn = $<HTMLButtonElement>("#signOutBtn");
const micSelect = $<HTMLSelectElement>("#micDevice");
const startBtn = $<HTMLButtonElement>("#startBtn");
const stopBtn = $<HTMLButtonElement>("#stopBtn");
const statusText = $<HTMLElement>("#statusText");
const statusDot = $<HTMLElement>("#statusDot");
const agentLevel = $<HTMLElement>("#agentLevel");
const customerLevel = $<HTMLElement>("#customerLevel");
const agentKb = $<HTMLElement>("#agentKb");
const customerKb = $<HTMLElement>("#customerKb");
const callIdEl = $<HTMLElement>("#callId");
const durationEl = $<HTMLElement>("#duration");
const backendEl = $<HTMLElement>("#backend");
const loginBackendEl = $<HTMLElement>("#loginBackend");

async function init() {
  const cfg = await window.j2w.getConfig();
  apiBaseUrl = cfg.apiBaseUrl;
  wsBaseUrl = cfg.wsBaseUrl;
  backendEl.textContent = apiBaseUrl;
  loginBackendEl.textContent = apiBaseUrl;

  loginForm.addEventListener("submit", onSignIn);
  signOutBtn.addEventListener("click", onSignOut);
  startBtn.addEventListener("click", () => void startManualCall());
  stopBtn.addEventListener("click", () => void stopCall());

  const session = await window.j2w.auth.me();
  if (session) {
    await showAppView(session);
  } else {
    showLoginView();
  }
}

function showLoginView(): void {
  loginView.hidden = false;
  appView.hidden = true;
}

interface SessionLike {
  user: { id: string; email: string; name: string | null; role: string; org: { id: string; name: string } };
}

async function showAppView(session: SessionLike): Promise<void> {
  loginView.hidden = true;
  appView.hidden = false;
  const display = session.user.name ?? session.user.email;
  userName.textContent = display;
  userEmail.textContent = `${session.user.email} · ${session.user.role}`;
  userAvatar.textContent = display
    .split(/[@\s.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
  await populateMics();
  openAgentSocket();
  setStatus("waiting for assignment…");
}

async function onSignIn(e: Event): Promise<void> {
  e.preventDefault();
  loginError.hidden = true;
  loginBtn.disabled = true;
  try {
    const { session } = await window.j2w.auth.signIn(loginEmail.value.trim(), loginPassword.value);
    if (!session) throw new Error("sign_in_failed");
    loginPassword.value = "";
    await showAppView(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    loginError.textContent = msg.includes("invalid_credentials")
      ? "Email or password is incorrect."
      : `Sign in failed: ${msg}`;
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
  }
}

async function onSignOut(): Promise<void> {
  closeAgentSocket();
  if (current) await stopCall();
  await window.j2w.auth.signOut();
  showLoginView();
}

async function populateMics() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (err) {
    setStatus("mic permission denied", "err");
    console.error(err);
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  micSelect.innerHTML = "";
  for (const d of devices.filter((d) => d.kind === "audioinput")) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${micSelect.options.length + 1}`;
    micSelect.appendChild(opt);
  }
}

// ---------- Agent WebSocket (push assignments / end events) ----------
async function openAgentSocket() {
  closeAgentSocket();
  const token = await window.j2w.auth.getAccessToken();
  if (!token) return;
  const ws = new WebSocket(`${wsBaseUrl}/ws/agent?token=${encodeURIComponent(token)}`);
  agentWs = ws;
  ws.addEventListener("open", () => console.log("[agent-ws] open"));
  ws.addEventListener("message", (ev) => void onAgentEvent(ev));
  ws.addEventListener("close", (ev) => {
    console.log("[agent-ws] close", ev.code);
    if (!loginView.hidden) return; // signed out — don't reconnect
    if (ev.code === 4401) {
      // Access token expired — the main process will refresh on next request.
      setTimeout(openAgentSocket, 500);
    } else {
      setTimeout(openAgentSocket, 3_000);
    }
  });
  ws.addEventListener("error", (err) => console.warn("[agent-ws] err", err));
}

function closeAgentSocket(): void {
  if (agentWs) {
    try { agentWs.close(); } catch { /* ignore */ }
    agentWs = null;
  }
}

async function onAgentEvent(ev: MessageEvent): Promise<void> {
  let msg: { type: string; callId?: string };
  try { msg = JSON.parse(ev.data as string); } catch { return; }
  if (msg.type === "call_assigned" && msg.callId) {
    if (current?.callId === msg.callId) return;
    console.log("[agent-ws] call_assigned", msg.callId);
    if (current) await stopCall();
    await beginCall(msg.callId, { accept: true });
  } else if (msg.type === "call_ended" && msg.callId) {
    if (current?.callId === msg.callId) await stopCall();
  }
}

// ---------- Manual fallback: create a desktop-origin call ----------
async function startManualCall() {
  if (current) return;
  const token = await window.j2w.auth.getAccessToken();
  if (!token) return setStatus("not signed in", "err");
  setStatus("creating call…");
  startBtn.disabled = true;
  try {
    const res = await fetch(`${apiBaseUrl}/api/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ origin: "desktop" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { callId: string };
    await beginCall(body.callId, { accept: true });
  } catch (err) {
    setStatus(`start failed: ${err instanceof Error ? err.message : String(err)}`, "err");
    startBtn.disabled = false;
  }
}

// ---------- Capture pipeline ----------
async function beginCall(callId: string, opts: { accept?: boolean } = {}): Promise<void> {
  if (current) return;
  const token = await window.j2w.auth.getAccessToken();
  if (!token) return setStatus("not signed in", "err");

  if (opts.accept) {
    try {
      await fetch(`${apiBaseUrl}/api/calls/${encodeURIComponent(callId)}/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // non-fatal — capture can proceed even if accept failed
    }
  }

  setStatus("opening audio…");
  startBtn.disabled = true;

  let agentStream: MediaStream | null = null;
  let customerStream: MediaStream | null = null;
  try {
    agentStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micSelect.value ? { exact: micSelect.value } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
  } catch {
    setStatus("mic denied", "err");
    startBtn.disabled = false;
    return;
  }

  try {
    customerStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });
    for (const t of customerStream.getVideoTracks()) t.stop();
  } catch (err) {
    console.warn("system audio denied, proceeding mic-only", err);
    customerStream = null;
  }

  const ws = new WebSocket(
    `${wsBaseUrl}/ws/ingest?callId=${encodeURIComponent(callId)}&token=${encodeURIComponent(token)}`,
  );
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  }).catch((err) => setStatus(`ws failed: ${err.message}`, "err"));

  const agent = await captureChannel(
    agentStream,
    AUDIO_CHANNEL_RECRUITER,
    ws,
    (n) => (agentKb.textContent = `${(n / 1024).toFixed(1)} KB`),
    (rms) => (agentLevel.style.width = `${Math.min(100, rms * 300)}%`),
  );
  let customer: ChannelState | null = null;
  if (customerStream) {
    customer = await captureChannel(
      customerStream,
      AUDIO_CHANNEL_CANDIDATE,
      ws,
      (n) => (customerKb.textContent = `${(n / 1024).toFixed(1)} KB`),
      (rms) => (customerLevel.style.width = `${Math.min(100, rms * 300)}%`),
    );
  }

  const startedAt = Date.now();
  const durationTimer = window.setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    durationEl.textContent = `${secs}s`;
  }, 500);

  current = { callId, ws, agent, customer, startedAt, durationTimer };
  callIdEl.textContent = callId.slice(0, 8) + "…";
  setStatus("live", "live");
  stopBtn.disabled = false;

  ws.addEventListener("close", () => {
    if (current && current.ws === ws) void stopCall();
  });
  void AUDIO_FRAME_BYTES;
}

async function captureChannel(
  stream: MediaStream,
  channelTag: number,
  ws: WebSocket,
  onBytes: (n: number) => void,
  onLevel: (rms: number) => void,
): Promise<ChannelState> {
  const context = new AudioContext();
  await context.audioWorklet.addModule(workletUrl);
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm-downsampler");
  source.connect(node);
  let bytesSent = 0;
  node.port.onmessage = (ev: MessageEvent) => {
    const data = ev.data as { type: string; pcm?: ArrayBuffer; rms?: number };
    if (data.type === "frame" && data.pcm) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const out = new Uint8Array(1 + data.pcm.byteLength);
      out[0] = channelTag;
      out.set(new Uint8Array(data.pcm), 1);
      ws.send(out);
      bytesSent += data.pcm.byteLength;
      onBytes(bytesSent);
    } else if (data.type === "level" && data.rms !== undefined) {
      onLevel(data.rms);
    }
  };
  return { stream, context, node, bytesSent: 0 };
}

async function stopCall() {
  const c = current;
  if (!c) return;
  current = null;
  window.clearInterval(c.durationTimer);
  try { c.ws.close(); } catch { /* ignore */ }
  for (const ch of [c.agent, c.customer]) {
    if (!ch) continue;
    try {
      ch.node.disconnect();
      ch.stream.getTracks().forEach((t) => t.stop());
      await ch.context.close();
    } catch { /* ignore */ }
  }
  const token = await window.j2w.auth.getAccessToken();
  if (token) {
    await fetch(`${apiBaseUrl}/api/calls/${encodeURIComponent(c.callId)}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  agentLevel.style.width = "0%";
  customerLevel.style.width = "0%";
  stopBtn.disabled = true;
  startBtn.disabled = false;
  callIdEl.textContent = "—";
  setStatus("waiting for assignment…");
}

function setStatus(text: string, variant: "idle" | "live" | "err" = "idle"): void {
  statusText.textContent = text;
  statusDot.className = `dot ${variant === "live" ? "live" : variant === "err" ? "err" : ""}`;
}

void init();
