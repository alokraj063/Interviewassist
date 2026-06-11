import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// Owns the live interview-flow state machine: setup -> first question -> verify ticks ->
// next question -> ... -> final score. The hook reads `transcriptLog` (from useAudioCapture)
// and reacts to it: candidate silence => verify, interviewer speaking => verify-and-advance.
//
//   startFlow({ interviewId, resumeFile })  — kicks off /assist/start + first /assist/next
//   markAnswered() / skip() / endNow()       — manual recruiter overrides
//   forceTick()                              — ↻ Check now button

const WATCH_MS = 400;
const SILENCE_MS = 1800;
const SAFETY_TICK_MS = 8000;
const MIN_ANSWER_CHARS = 20;
const ADVANCE_LOCK_MS = 1200;

export function useInterviewFlow({ transcriptLog }) {
  const [sessionId, setSessionId] = useState(null);
  const [snapshot, setSnapshot] = useState(null);     // {summary, fitVerdict, strengths, gaps}
  const [current, setCurrent] = useState(null);       // {category, question}
  const [history, setHistory] = useState([]);         // [{category, question, answer, verdict, feedback}]
  const [latest, setLatest]   = useState(null);       // {verdict, kind, feedback, followUp, answer}
  const [finalScore, setFinalScore] = useState(null); // /assist/final response
  const [status, setStatus]   = useState({ text: '', kind: '' });
  const [running, setRunning] = useState(false);

  const stateRef = useRef({
    currentStartLen: 0, lastSeenLen: 0, lastTickedLen: 0,
    ticking: false, fetchingNext: false,
    advanceLockUntil: 0,
    silenceTimer: null, safetyTimer: null, watcherTimer: null,
    sessionId: null, current: null, history: [], running: false,
    transcriptLog,
  });

  // Keep refs in sync with state so timer callbacks see fresh values
  useEffect(() => { stateRef.current.transcriptLog = transcriptLog; }, [transcriptLog]);
  useEffect(() => { stateRef.current.sessionId = sessionId; }, [sessionId]);
  useEffect(() => { stateRef.current.current   = current;   }, [current]);
  useEffect(() => { stateRef.current.history   = history;   }, [history]);
  useEffect(() => { stateRef.current.running   = running;   }, [running]);

  // ------------------------------------------------------------------
  // capturedAnswer: candidate turns since current question went active
  // ------------------------------------------------------------------
  const capturedAnswer = useCallback(() => {
    const { transcriptLog: log, currentStartLen } = stateRef.current;
    return (log || [])
      .slice(currentStartLen)
      .filter((t) => !((t.speaker || '').toLowerCase().startsWith('interviewer')))
      .map((t) => t.text).join(' ').trim();
  }, []);

  // ------------------------------------------------------------------
  // tick: verify, then advance if satisfied
  // ------------------------------------------------------------------
  const tick = useCallback(async (forced = false) => {
    const st = stateRef.current;
    if (!st.sessionId || st.ticking || st.fetchingNext || !st.current || !st.running) return;
    if (Date.now() < st.advanceLockUntil) return;
    const log = st.transcriptLog || [];
    if (!forced && log.length === st.lastTickedLen) return;
    const answer = capturedAnswer();
    if (!forced && answer.length < MIN_ANSWER_CHARS) return;

    st.lastTickedLen = log.length;
    st.ticking = true;
    try {
      const data = await api.assistVerify(st.sessionId, st.current.question, answer);
      if (!data.ok) { setStatus({ text: data.error || 'Verification failed.', kind: 'error' }); return; }
      const kind = VERDICT_KIND[data.verdict] || (data.satisfied ? 'ok' : 'weak');
      setLatest({
        verdict: data.verdict || (data.satisfied ? 'OK' : 'Weak'),
        kind, feedback: data.feedback || '', followUp: data.followUp || '',
        answer,
      });
      if (data.satisfied) await advance(data, answer);
    } catch {
      setStatus({ text: 'Network error during verification.', kind: 'error' });
    } finally {
      st.ticking = false;
    }
  }, [capturedAnswer]);

  // ------------------------------------------------------------------
  // advance: push the answered Q into history, fetch the next one
  // ------------------------------------------------------------------
  const advance = useCallback(async (verifyData, answer) => {
    const st = stateRef.current;
    st.advanceLockUntil = Date.now() + ADVANCE_LOCK_MS;
    if (st.silenceTimer) clearTimeout(st.silenceTimer);
    const entry = {
      category: (st.current && st.current.category) || '',
      question: (st.current && st.current.question) || '',
      answer:   answer || capturedAnswer() || '',
      verdict:  (verifyData && verifyData.verdict)  || 'Adequate',
      feedback: (verifyData && verifyData.feedback) || '',
    };
    const nextHistory = [...st.history, entry];
    setHistory(nextHistory);
    st.history = nextHistory;
    await fetchNext(nextHistory);
  }, [capturedAnswer]);

  const fetchNext = useCallback(async (historyOverride) => {
    const st = stateRef.current;
    if (!st.sessionId || st.fetchingNext) return;
    st.fetchingNext = true;
    const useHistory = historyOverride || st.history;
    setStatus({ text: useHistory.length ? 'Choosing the next question…' : 'Designing the first question…', kind: '' });
    try {
      const data = await api.assistNext(st.sessionId, useHistory);
      if (!data.ok) { setStatus({ text: data.error || 'Could not get the next question.', kind: 'error' }); return; }
      if (data.done || !data.question) {
        await finish('You have enough signal — generating the final score…');
        return;
      }
      const c = { category: data.category || '—', question: data.question };
      setCurrent(c);
      st.current = c;
      st.currentStartLen = (st.transcriptLog || []).length;
      st.lastTickedLen = st.currentStartLen;
      st.lastSeenLen   = st.currentStartLen;
      setLatest(null);
      setStatus({ text: 'Live — ask the question. I’ll auto-advance once they answer.', kind: 'ok' });
    } catch {
      setStatus({ text: 'Network error fetching the next question.', kind: 'error' });
    } finally {
      st.fetchingNext = false;
    }
  }, []);

  // ------------------------------------------------------------------
  // Watcher: react INSTANTLY to live transcript changes
  // ------------------------------------------------------------------
  const watcher = useCallback(() => {
    const st = stateRef.current;
    if (!st.running || !st.current) return;
    const log = st.transcriptLog || [];
    if (log.length === st.lastSeenLen) return;
    const newTurns = log.slice(st.lastSeenLen);
    st.lastSeenLen = log.length;
    const interviewerSpoke = newTurns.some((t) => (t.speaker || '').toLowerCase().startsWith('interviewer'));
    if (st.silenceTimer) clearTimeout(st.silenceTimer);
    if (interviewerSpoke) tick();
    else st.silenceTimer = setTimeout(() => tick(), SILENCE_MS);
  }, [tick]);

  // ------------------------------------------------------------------
  // startFlow: /assist/start + first /assist/next + timers
  // ------------------------------------------------------------------
  const startFlow = useCallback(async ({ interviewId, resumeFile }) => {
    if (!interviewId || !resumeFile) {
      setStatus({ text: 'Interview id or resume missing.', kind: 'error' });
      return false;
    }
    setStatus({ text: 'Reading the resume and the JD…', kind: '' });
    const fd = new FormData();
    fd.append('interview_id', interviewId);
    fd.append('resume_file', resumeFile);
    let startData;
    try { startData = await api.assistStart(fd); }
    catch { setStatus({ text: 'Network error loading the resume.', kind: 'error' }); return false; }
    if (!startData.ok) { setStatus({ text: startData.error || 'Could not load the resume.', kind: 'error' }); return false; }
    setSessionId(startData.sessionId);
    stateRef.current.sessionId = startData.sessionId;
    setSnapshot({
      summary: startData.summary, fitVerdict: startData.fitVerdict,
      strengths: startData.strengths || [], gaps: startData.gaps || [],
    });
    setRunning(true);
    stateRef.current.running = true;
    await fetchNext([]);
    // Start timers
    const st = stateRef.current;
    if (st.watcherTimer) clearInterval(st.watcherTimer);
    if (st.safetyTimer)  clearInterval(st.safetyTimer);
    st.watcherTimer = setInterval(watcher, WATCH_MS);
    st.safetyTimer  = setInterval(() => tick(),  SAFETY_TICK_MS);
    return true;
  }, [fetchNext, tick, watcher]);

  // ------------------------------------------------------------------
  // finish + final score
  // ------------------------------------------------------------------
  const finish = useCallback(async (msg) => {
    const st = stateRef.current;
    setRunning(false); st.running = false;
    setCurrent(null);  st.current = null;
    if (st.safetyTimer)  clearInterval(st.safetyTimer);
    if (st.watcherTimer) clearInterval(st.watcherTimer);
    if (st.silenceTimer) clearTimeout(st.silenceTimer);
    setStatus({ text: msg || 'Generating the final score…', kind: '' });
    if (!st.sessionId || !st.history.length) {
      setStatus({ text: 'No questions asked yet — nothing to score.', kind: 'error' });
      return;
    }
    try {
      const data = await api.assistFinal(st.sessionId, st.history);
      if (!data.ok) { setStatus({ text: data.error || 'Final scoring failed.', kind: 'error' }); return; }
      setFinalScore(data);
      setStatus({ text: 'Done — final score ready.', kind: 'ok' });
    } catch {
      setStatus({ text: 'Network error generating the final score.', kind: 'error' });
    }
  }, []);

  // ------------------------------------------------------------------
  // Manual overrides
  // ------------------------------------------------------------------
  const markAnswered = useCallback(async () => {
    const st = stateRef.current;
    if (!st.current || !st.running) return;
    await advance({ verdict: 'Manually accepted', feedback: '' }, capturedAnswer());
  }, [advance, capturedAnswer]);

  const skip = useCallback(async () => {
    const st = stateRef.current;
    if (!st.current || !st.running) return;
    const entry = {
      category: st.current.category || '', question: st.current.question,
      answer: capturedAnswer() || '', verdict: 'Skipped', feedback: '',
    };
    const next = [...st.history, entry];
    setHistory(next); st.history = next;
    await fetchNext(next);
  }, [capturedAnswer, fetchNext]);

  const endNow = useCallback(async () => {
    await finish('Wrapping up early — generating the final score…');
  }, [finish]);

  const forceTick = useCallback(() => tick(true), [tick]);

  const reset = useCallback(() => {
    const st = stateRef.current;
    if (st.safetyTimer)  clearInterval(st.safetyTimer);
    if (st.watcherTimer) clearInterval(st.watcherTimer);
    if (st.silenceTimer) clearTimeout(st.silenceTimer);
    Object.assign(st, {
      currentStartLen: 0, lastSeenLen: 0, lastTickedLen: 0,
      ticking: false, fetchingNext: false, advanceLockUntil: 0,
      silenceTimer: null, safetyTimer: null, watcherTimer: null,
      sessionId: null, current: null, history: [], running: false,
    });
    setSessionId(null); setSnapshot(null); setCurrent(null);
    setHistory([]); setLatest(null); setFinalScore(null);
    setStatus({ text: '', kind: '' }); setRunning(false);
  }, []);

  useEffect(() => () => {
    const st = stateRef.current;
    if (st.safetyTimer)  clearInterval(st.safetyTimer);
    if (st.watcherTimer) clearInterval(st.watcherTimer);
    if (st.silenceTimer) clearTimeout(st.silenceTimer);
  }, []);

  return {
    sessionId, snapshot, current, history, latest, finalScore,
    status, running,
    startFlow, markAnswered, skip, endNow, forceTick, reset,
  };
}

const VERDICT_KIND = {
  Strong: 'ok', Adequate: 'ok',
  Weak: 'weak', Vague: 'weak',
  'Off-topic': 'bad',
};
