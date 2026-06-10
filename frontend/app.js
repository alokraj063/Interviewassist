// Interview Assist — frontend controller.
//
// Two audio sources, two Deepgram Flux streams, exact speaker labels:
//   • Interviewer = your microphone        (getUserMedia)
//   • Candidate   = the call's audio        (getDisplayMedia — "share tab audio")
//
// Each source is resampled to 16 kHz linear16 PCM in an AudioWorklet, then sent
// as binary frames to the backend, which proxies them to Deepgram.

const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`;

const els = {
  start: document.getElementById('startBtn'),
  stop: document.getElementById('stopBtn'),
  clear: document.getElementById('clearBtn'),
  copy: document.getElementById('copyBtn'),
  transcript: document.getElementById('transcript'),
  empty: document.getElementById('emptyState'),
  micDot: document.getElementById('micStatus'),
  callDot: document.getElementById('callStatus'),
  banner: document.getElementById('banner'),
};

// One live "session" holds everything we need to tear down cleanly.
let session = null;
// Shared timestamp id for the current session — both sources write the same file.
let sessionId = null;

// Unified, ordered log of finalized turns — read by the co-pilot (assist.js).
const transcriptLog = [];
window.getTranscript = () => transcriptLog;

// Persist a finalized turn to the backend (fire-and-forget; never block the UI).
function saveTurn(speaker, text) {
  if (!sessionId || !text) return;
  const time = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  fetch('/transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId, speaker, text, time }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// A single audio source: stream -> worklet -> websocket -> Deepgram.
// ---------------------------------------------------------------------------
class Source {
  constructor(role, stream, dot) {
    this.role = role;
    this.stream = stream;
    this.dot = dot;
    this.ws = null;
    this.ctx = null;
    this.node = null;
    this.currentTurn = null; // the live (in-progress) bubble for this speaker
    this.committed = '';     // joined is_final segments of the current utterance
    this.interim = '';       // latest non-final partial
    this.previewSpeaker = null; // phone mode: speaker of the current live-preview bubble
  }

  async start() {
    this.ws = new WebSocket(`${WS_BASE}?role=${this.role}`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => setDot(this.dot, 'live');
    this.ws.onclose = () => setDot(this.dot, 'off');
    this.ws.onerror = () => setDot(this.dot, 'error');
    this.ws.onmessage = (ev) => this.onMessage(ev);

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-processor');
    this.node.port.onmessage = (e) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(e.data);
    };
    src.connect(this.node);
    // Worklet has no audible output; connecting to destination keeps it pumping
    // on some browsers without producing sound (we send a muted gain of 0).
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
  }

  onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type !== 'transcript') return;

    // Phone mode: the backend has already diarized the mixed-mono stream and sends
    // each final as a complete, speaker-labelled turn — handle those discretely
    // (the committed/interim accumulation below assumes one speaker per stream).
    if (msg.mode === 'phone') { this.onPhoneMessage(msg); return; }

    // nova-3 streaming: accumulate is_final segments, replace the interim tail,
    // and finalize the bubble when the utterance naturally ends (speech_final).
    const text = (msg.transcript || '').trim();
    if (msg.isFinal) {
      this.committed = (this.committed + ' ' + text).trim();
      this.interim = '';
    } else {
      this.interim = text;
    }

    const display = (this.committed + ' ' + this.interim).trim();
    if (display && !this.currentTurn) {
      this.currentTurn = addBubble(msg.role, msg.speaker);
    }
    if (this.currentTurn) setBubbleText(this.currentTurn, display);

    if (msg.speechFinal && this.currentTurn) {
      const finalText = (this.committed + ' ' + this.interim).trim();
      finalizeBubble(this.currentTurn);
      this.currentTurn = null;
      this.committed = '';
      this.interim = '';
      if (finalText) {
        saveTurn(msg.speaker, finalText);
        transcriptLog.push({ speaker: msg.speaker, text: finalText });
      }
    }
  }

  // Phone mode: the backend diarizes the mixed stream and sends discrete turns.
  onPhoneMessage(msg) {
    const text = (msg.transcript || '').trim();

    // Turn boundary flush: drop any dangling live-preview bubble.
    if (msg.speechFinal && !text) {
      this.clearPreview();
      return;
    }

    if (msg.isFinal) {
      // A complete, diarized turn — replace the live preview with a finalized bubble.
      this.clearPreview();
      if (!text) return;
      const row = addBubble('phone', msg.speaker);
      setBubbleText(row, text);
      finalizeBubble(row);
      saveTurn(msg.speaker, text);
      transcriptLog.push({ speaker: msg.speaker, text });
      return;
    }

    // Interim: keep one live-preview bubble; restart it when the speaker changes.
    if (!text) return;
    if (!this.currentTurn || this.previewSpeaker !== msg.speaker) {
      this.clearPreview();
      this.currentTurn = addBubble('phone', msg.speaker);
      this.previewSpeaker = msg.speaker;
    }
    setBubbleText(this.currentTurn, text);
  }

  clearPreview() {
    if (this.currentTurn) { try { this.currentTurn.remove(); } catch {} }
    this.currentTurn = null;
    this.previewSpeaker = null;
  }

  stop() {
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (this.node) this.node.disconnect(); } catch {}
    try { if (this.ctx) this.ctx.close(); } catch {}
    try { if (this.ws) this.ws.close(); } catch {}
    if (this.currentTurn) finalizeBubble(this.currentTurn);
    this.currentTurn = null;
    this.committed = '';
    this.interim = '';
    setDot(this.dot, 'off');
  }
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------
function addBubble(role, speaker) {
  els.empty.style.display = 'none';
  const row = document.createElement('div');
  // Phone mode shares one role ("phone") for both voices — colour by speaker number
  // (Speaker 1 / Speaker 2 → turn--s1 / turn--s2) so the two sides read distinctly.
  const m = role === 'phone' && /(\d+)/.exec(speaker || '');
  const speakerClass = m ? ` turn--s${m[1]}` : '';
  row.className = `turn turn--${role}${speakerClass} turn--interim`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `
    <div class="turn__meta"><span class="turn__who">${speaker}</span><span class="turn__time">${time}</span></div>
    <div class="turn__text"></div>`;
  els.transcript.appendChild(row);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return row;
}

function setBubbleText(row, text) {
  row.querySelector('.turn__text').textContent = text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function finalizeBubble(row) {
  row.classList.remove('turn--interim');
}

// ---------------------------------------------------------------------------
// Status dots + banner
// ---------------------------------------------------------------------------
function setDot(dot, state) {
  if (dot) dot.dataset.state = state;
}

function showBanner(text, kind = 'error') {
  els.banner.textContent = text;
  els.banner.dataset.kind = kind;
  els.banner.style.display = text ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------
function micErrorMessage(err) {
  // macOS Chrome rejects with NotAllowedError (often with no prompt) when the OS
  // itself blocks the mic. NotFoundError means no input device at all.
  if (err && err.name === 'NotAllowedError') {
    return 'Mic blocked. On macOS: System Settings → Privacy & Security → Microphone → '
      + 'enable Google Chrome, then fully quit & reopen Chrome. Also check the address-bar '
      + 'camera/site icon isn’t set to Block.';
  }
  if (err && err.name === 'NotFoundError') {
    return 'No microphone found. Plug one in (or check input settings) and try again.';
  }
  return `Microphone error: ${err?.name || ''} ${err?.message || ''}`.trim();
}

// Selected capture mode: 'vc' (mic + shared tab audio) or 'phone' (single mixed mic).
function currentMode() {
  const r = document.querySelector('input[name="callMode"]:checked');
  return (r && r.value) || 'vc';
}

// Timestamped session id, e.g. 2026-06-04_18-19-30 — shared by every source.
function makeSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Browsers only expose mic/screen capture in a secure context (https or localhost).
function captureUnavailable() {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) return false;
  const where = location.protocol === 'file:'
    ? 'a file:// path'
    : `${location.protocol}//${location.host}`;
  const port = location.port || '3001';
  showBanner(
    `Audio capture is unavailable on ${where}. Browsers only allow mic/tab capture on a `
    + `secure origin — open the app at http://localhost:${port} (or http://127.0.0.1:${port}), `
    + `not 0.0.0.0, a LAN IP, or a file path.`,
    'error',
  );
  return true;
}

// Phone mode: candidate on speakerphone, both voices reach the laptop mic as one
// mixed-mono stream. One Deepgram stream + live diarization splits Speaker 1 / 2.
async function startPhoneSession() {
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      // EC OFF on purpose: the candidate's voice arrives via the phone speaker into
      // the laptop mic; echo cancellation would suppress it.
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    showBanner(micErrorMessage(err));
    els.start.disabled = false;
    return;
  }

  sessionId = window.ensureInterview ? await window.ensureInterview() : makeSessionId();
  session = { phone: new Source('phone', micStream, els.micDot) };
  await session.phone.start();

  els.stop.disabled = false;
  showBanner(
    'Listening — Phone (mixed mic). Keep the candidate on speakerphone near the mic. '
    + 'Speakers are separated automatically (Speaker 1 / 2, best-effort).',
    'info',
  );
}

async function startSession() {
  showBanner('');

  // On http://0.0.0.0, a LAN IP, or a file:// path, navigator.mediaDevices is
  // undefined — fail with a clear instruction instead of a cryptic TypeError.
  if (captureUnavailable()) return;

  els.start.disabled = true;

  if (currentMode() === 'phone') {
    await startPhoneSession();
    return;
  }

  // Try each source independently — one failing must not abort the other.
  let micStream = null;
  let callStream = null;
  let micErr = null;
  let callErr = null;

  // 1) Interviewer microphone.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch (err) {
    micErr = err;
  }

  // 2) Candidate = call audio via screen/tab share. The user must tick
  //    "Share tab audio" (Chrome) / "Share system audio" when prompted.
  try {
    callStream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by spec; we only keep the audio track
      audio: { echoCancellation: false, noiseSuppression: false },
    });
    callStream.getVideoTracks().forEach((t) => t.stop()); // drop video, keep audio
    if (callStream.getAudioTracks().length === 0) {
      callStream.getTracks().forEach((t) => t.stop());
      callStream = null;
      callErr = { name: 'NoAudio' };
    }
  } catch (err) {
    callErr = err;
  }

  // Nothing usable — report the most relevant reason and bail.
  if (!micStream && !callStream) {
    const msg = micErr
      ? micErrorMessage(micErr)
      : 'No audio captured. Pick the Teams / Zoom / Meet / FreJun tab and tick "Share tab audio".';
    showBanner(msg);
    els.start.disabled = false;
    return;
  }

  // One interview id ties the transcript file, co-pilot session, and saved record.
  sessionId = window.ensureInterview ? await window.ensureInterview() : makeSessionId();

  session = {
    interviewer: micStream ? new Source('interviewer', micStream, els.micDot) : null,
    candidate: callStream ? new Source('candidate', callStream, els.callDot) : null,
  };

  if (session.interviewer) await session.interviewer.start();
  if (session.candidate) await session.candidate.start();

  els.stop.disabled = false;

  // Tell the user exactly what's live and what's missing.
  if (micStream && callStream) {
    showBanner('Listening — Interviewer (mic) + Candidate (call audio). Keep the shared tab open.', 'info');
  } else if (callStream) {
    showBanner('Candidate (call audio) only — mic is off. ' + micErrorMessage(micErr), 'error');
  } else {
    const callMsg = callErr && callErr.name === 'NoAudio'
      ? 'No audio in the shared tab — re-share with "Share tab audio" ticked.'
      : 'Call audio not shared.';
    showBanner('Interviewer (mic) only — ' + callMsg, 'info');
  }
}

function stopSession() {
  if (session) {
    if (session.interviewer) session.interviewer.stop();
    if (session.candidate) session.candidate.stop();
    if (session.phone) session.phone.stop();
    session = null;
  }
  els.start.disabled = false;
  els.stop.disabled = true;
  showBanner('');
  // Mark the interview ended and free the binding so the next candidate gets a
  // fresh interview (the saved transcript stays on screen until then).
  if (window.endInterview) window.endInterview();
}

// Clear the live transcript + log (used by the Clear button and when a new
// interview starts). Exposed for assist.js's ensureInterview().
function resetTranscript() {
  els.transcript.querySelectorAll('.turn').forEach((n) => n.remove());
  els.empty.style.display = 'block';
  transcriptLog.length = 0;
}
window.resetTranscript = resetTranscript;

// Reflect the selected mode in the status row (Phone uses a single mixed-mic dot).
function updateModeUI() {
  const phone = currentMode() === 'phone';
  const micLabel = document.getElementById('micLabel');
  const candidateStatus = document.getElementById('candidateStatus');
  if (micLabel) micLabel.textContent = phone ? 'Phone (mixed mic)' : 'Interviewer (mic)';
  if (candidateStatus) candidateStatus.style.display = phone ? 'none' : '';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
els.start.addEventListener('click', startSession);
els.stop.addEventListener('click', stopSession);
document.querySelectorAll('input[name="callMode"]').forEach((r) =>
  r.addEventListener('change', updateModeUI));
updateModeUI();
els.clear.addEventListener('click', resetTranscript);
els.copy.addEventListener('click', async () => {
  const lines = [...els.transcript.querySelectorAll('.turn')].map((row) => {
    const who = row.querySelector('.turn__who').textContent;
    const text = row.querySelector('.turn__text').textContent;
    return `${who}: ${text}`;
  });
  await navigator.clipboard.writeText(lines.join('\n'));
  els.copy.textContent = 'Copied!';
  setTimeout(() => (els.copy.textContent = 'Copy'), 1200);
});

window.addEventListener('beforeunload', stopSession);
