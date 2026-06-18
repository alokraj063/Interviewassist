// Single audio source: stream -> AudioWorklet -> WebSocket -> Deepgram.
//
// One Source instance per audio track:
//   - "interviewer": your microphone (getUserMedia)
//   - "candidate":   the call's audio (getDisplayMedia, "share tab audio")
//   - "phone":       mixed mic, diarized server-side into Speaker 1 / Speaker 2

import { getToken } from './auth';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/stream`;

export class Source {
  constructor(role, stream, onTranscript) {
    this.role = role;
    this.stream = stream;
    this.onTranscript = onTranscript;
    this.ws = null;
    this.ctx = null;
    this.node = null;
    this.currentTurn = null;
    this.committed = '';
    this.interim = '';
    this.previewSpeaker = null;
    this.onDot = null;
  }

  async start() {
    this.ws = new WebSocket(`${WS_BASE}?role=${this.role}&token=${encodeURIComponent(getToken() || '')}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen  = () => this.onDot && this.onDot('live');
    this.ws.onclose = () => this.onDot && this.onDot('off');
    this.ws.onerror = () => this.onDot && this.onDot('error');
    this.ws.onmessage = (ev) => this.onMessage(ev);

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(`${BASE}/pcm-worklet.js`);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-processor');
    this.node.port.onmessage = (e) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(e.data);
    };
    src.connect(this.node);
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
  }

  onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== 'transcript') return;
    if (msg.mode === 'phone') { this.onPhoneMessage(msg); return; }

    const text = (msg.transcript || '').trim();
    if (msg.isFinal) {
      this.committed = (this.committed + ' ' + text).trim();
      this.interim = '';
    } else {
      this.interim = text;
    }
    const display = (this.committed + ' ' + this.interim).trim();

    // Emit a "preview" event for live partial display; we don't store interim turns.
    this.onTranscript({
      kind: msg.speechFinal ? 'final' : 'interim',
      role: msg.role, speaker: msg.speaker,
      text: display,
      finalText: msg.speechFinal ? (this.committed + ' ' + this.interim).trim() : '',
    });
    if (msg.speechFinal) {
      this.committed = '';
      this.interim = '';
    }
  }

  onPhoneMessage(msg) {
    const text = (msg.transcript || '').trim();
    if (msg.speechFinal && !text) {
      this.onTranscript({ kind: 'preview-clear', role: 'phone', speaker: this.previewSpeaker });
      this.previewSpeaker = null;
      return;
    }
    if (msg.isFinal) {
      this.previewSpeaker = null;
      this.onTranscript({
        kind: 'final', role: 'phone', speaker: msg.speaker,
        text: '', finalText: text,
      });
      return;
    }
    if (!text) return;
    if (this.previewSpeaker !== msg.speaker) {
      this.onTranscript({ kind: 'preview-clear', role: 'phone', speaker: this.previewSpeaker });
      this.previewSpeaker = msg.speaker;
    }
    this.onTranscript({
      kind: 'interim', role: 'phone', speaker: msg.speaker, text, finalText: '',
    });
  }

  stop() {
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (this.node) this.node.disconnect(); } catch {}
    try { if (this.ctx)  this.ctx.close(); } catch {}
    try { if (this.ws)   this.ws.close(); } catch {}
    this.committed = '';
    this.interim = '';
    this.onDot && this.onDot('off');
  }
}

export function micErrorMessage(err) {
  if (err && err.name === 'NotAllowedError') {
    return 'Mic blocked. On macOS: System Settings → Privacy & Security → Microphone → '
      + 'enable Google Chrome, then fully quit & reopen Chrome.';
  }
  if (err && err.name === 'NotFoundError') {
    return 'No microphone found. Plug one in (or check input settings) and try again.';
  }
  return `Microphone error: ${err?.name || ''} ${err?.message || ''}`.trim();
}

export function captureUnavailable() {
  return !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export function makeSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
