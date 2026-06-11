import { useCallback, useEffect, useRef, useState } from 'react';
import { Source, makeSessionId, micErrorMessage, captureUnavailable } from '../lib/audio';
import { api } from '../lib/api';

// Owns: media capture, WebSocket sources, and the live transcript log.
//
// Exposes:
//   transcriptLog  — array of finalised turns [{speaker, text, time}]
//   livePreviews   — per-source live (interim) bubble {role, speaker, text}
//   start({ mode })  — kicks off mic and (for VC) display media
//   stop()         — tears everything down
//   micState / callState — 'off' | 'live' | 'error'
//   banner         — current banner message
//   ensureInterview — creates/returns a backend interview row (shared id)

export function useAudioCapture({ clientId, jdId }) {
  const [transcriptLog, setTranscriptLog] = useState([]);
  const [livePreviews, setLivePreviews] = useState({}); // keyed by `${role}:${speaker}`
  const [micState, setMicState]  = useState('off');
  const [callState, setCallState] = useState('off');
  const [banner, setBanner] = useState(null);
  const sessionRef = useRef(null);
  const sessionIdRef = useRef(null);
  const interviewRef = useRef(null);

  // ---------- transcript callbacks (called by Source instances) ----------
  const handleTranscript = useCallback((evt) => {
    const previewKey = `${evt.role}:${evt.speaker || ''}`;
    if (evt.kind === 'preview-clear') {
      setLivePreviews((p) => {
        const next = { ...p };
        if (evt.speaker) delete next[`${evt.role}:${evt.speaker}`];
        else Object.keys(next).filter((k) => k.startsWith(evt.role + ':')).forEach((k) => delete next[k]);
        return next;
      });
      return;
    }
    if (evt.kind === 'interim') {
      setLivePreviews((p) => ({ ...p, [previewKey]: { role: evt.role, speaker: evt.speaker, text: evt.text } }));
      return;
    }
    // 'final'
    setLivePreviews((p) => { const n = { ...p }; delete n[previewKey]; return n; });
    const text = (evt.finalText || evt.text || '').trim();
    if (!text) return;
    const time = new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    setTranscriptLog((log) => [...log, { speaker: evt.speaker, text, time }]);
    if (sessionIdRef.current) {
      api.saveTurn({ session: sessionIdRef.current, speaker: evt.speaker, text, time });
    }
  }, []);

  // ---------- interview row helpers ----------
  const ensureInterview = useCallback(async (callMode) => {
    if (interviewRef.current) return interviewRef.current.id;
    try {
      const data = await api.createInterview({
        client_id: clientId || null, jd_id: jdId || null,
        candidate_name: '', call_mode: callMode || 'vc',
      });
      if (data.ok && data.interview) {
        interviewRef.current = { id: data.interview.id, clientId, jdId };
        sessionIdRef.current = data.interview.id;
        return data.interview.id;
      }
    } catch {}
    const id = makeSessionId();
    interviewRef.current = { id, clientId, jdId, local: true };
    sessionIdRef.current = id;
    return id;
  }, [clientId, jdId]);

  const endInterview = useCallback(async () => {
    const it = interviewRef.current;
    interviewRef.current = null;
    sessionIdRef.current = null;
    if (it && !it.local) { try { await api.endInterview(it.id); } catch {} }
  }, []);

  // ---------- start / stop ----------
  const start = useCallback(async ({ mode } = { mode: 'vc' }) => {
    setBanner(null);
    if (captureUnavailable()) {
      setBanner({ kind: 'error', text: 'Audio capture is unavailable — open at http://localhost:5173 (or the FastAPI port).' });
      throw new Error('capture unavailable');
    }

    // Reset transcript for a fresh interview
    setTranscriptLog([]); setLivePreviews({});
    await ensureInterview(mode);

    if (mode === 'phone') {
      let micStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (err) {
        setBanner({ kind: 'error', text: micErrorMessage(err) });
        throw err;
      }
      const phoneSrc = new Source('phone', micStream, handleTranscript);
      phoneSrc.onDot = setMicState;
      await phoneSrc.start();
      sessionRef.current = { phone: phoneSrc };
      setBanner({
        kind: 'info',
        text: 'Listening — Phone (mixed mic). Speakers are separated automatically (Speaker 1 / 2, best-effort).',
      });
      return;
    }

    // VC mode: mic + display media
    let micStream = null, callStream = null, micErr = null, callErr = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) { micErr = err; }
    try {
      callStream = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: { echoCancellation: false, noiseSuppression: false },
      });
      callStream.getVideoTracks().forEach((t) => t.stop());
      if (callStream.getAudioTracks().length === 0) {
        callStream.getTracks().forEach((t) => t.stop());
        callStream = null; callErr = { name: 'NoAudio' };
      }
    } catch (err) { callErr = err; }

    if (!micStream && !callStream) {
      const msg = micErr ? micErrorMessage(micErr)
        : 'No audio captured. Pick the Teams / Zoom / Meet tab and tick "Share tab audio".';
      setBanner({ kind: 'error', text: msg });
      throw new Error(msg);
    }

    sessionRef.current = {
      interviewer: micStream  ? new Source('interviewer', micStream,  handleTranscript) : null,
      candidate:   callStream ? new Source('candidate',   callStream, handleTranscript) : null,
    };
    if (sessionRef.current.interviewer) { sessionRef.current.interviewer.onDot = setMicState;  await sessionRef.current.interviewer.start(); }
    if (sessionRef.current.candidate)   { sessionRef.current.candidate.onDot   = setCallState; await sessionRef.current.candidate.start(); }

    if (micStream && callStream) {
      setBanner({ kind: 'info', text: 'Listening — Interviewer (mic) + Candidate (call audio). Keep the shared tab open.' });
    } else if (callStream) {
      setBanner({ kind: 'error', text: 'Candidate (call audio) only — mic is off. ' + (micErr ? micErrorMessage(micErr) : '') });
    } else {
      const callMsg = callErr && callErr.name === 'NoAudio'
        ? 'No audio in the shared tab — re-share with "Share tab audio" ticked.'
        : 'Call audio not shared.';
      setBanner({ kind: 'info', text: 'Interviewer (mic) only — ' + callMsg });
    }
  }, [ensureInterview, handleTranscript]);

  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (s) {
      if (s.interviewer) s.interviewer.stop();
      if (s.candidate)   s.candidate.stop();
      if (s.phone)       s.phone.stop();
    }
    sessionRef.current = null;
    setMicState('off'); setCallState('off');
    setBanner(null);
    endInterview();
  }, [endInterview]);

  const clearTranscript = useCallback(() => {
    setTranscriptLog([]); setLivePreviews({});
  }, []);

  useEffect(() => () => stop(), []); // cleanup on unmount

  return {
    transcriptLog, livePreviews,
    micState, callState, banner,
    start, stop, clearTranscript,
    interviewRef,
  };
}
