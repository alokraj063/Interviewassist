// Live interview-flow state machine for the recruiter wedge — ported from the
// standalone Interview-Assist project's useInterviewFlow and adapted to our
// transcript source (useWedgeCall's `turns`) and our /api/assist/* endpoints.
//
//   plan (fit + question plan)  →  current question  →  verify (answered?)
//   →  advance to next question  →  …  →  final score
//
// It reads the live transcript and reacts: candidate goes quiet → verify the
// current answer; recruiter starts speaking → verify-and-advance. It NEVER
// fires a random question — there is always exactly one current question, and
// it only advances once the candidate has actually answered (or the recruiter
// manually accepts / skips). The recruiter can also ask their own question;
// when they speak, the loop re-checks and moves on.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export interface FlowTurn {
  speaker: string; // "recruiter" | "candidate" | "unknown"
  text: string;
}
export interface CurrentQuestion {
  category: string;
  question: string;
}
export interface HistoryEntry {
  category: string;
  question: string;
  answer: string;
  verdict: string;
  feedback: string;
}
export interface LatestVerdict {
  verdict: string;
  kind: "ok" | "weak" | "bad";
  feedback: string;
  followUp: string;
  answer: string;
}
export interface FlowSnapshot {
  fitVerdict: string;
  summary: string;
  strengths: string[];
  gaps: string[];
}
export interface FinalScore {
  verdict: string;
  score: Record<string, number>;
  summary: string;
  strengths: string[];
  concerns: string[];
  saved?: boolean;
}

const WATCH_MS = 500;
const SILENCE_MS = 1800;
const SAFETY_TICK_MS = 9000;
const MIN_ANSWER_CHARS = 20;
const ADVANCE_LOCK_MS = 1500;

const VERDICT_KIND: Record<string, "ok" | "weak" | "bad"> = {
  Strong: "ok",
  Adequate: "ok",
  Weak: "weak",
  Vague: "weak",
  "Off-topic": "bad",
};

const isRecruiter = (speaker: string) => (speaker || "").toLowerCase().startsWith("recruiter");

export function useInterviewFlow(transcriptLog: FlowTurn[]) {
  const [callId, setCallId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(null);
  const [plan, setPlan] = useState<Array<{ name: string; questions: string[] }>>([]);
  const [current, setCurrent] = useState<CurrentQuestion | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [latest, setLatest] = useState<LatestVerdict | null>(null);
  const [finalScore, setFinalScore] = useState<FinalScore | null>(null);
  const [status, setStatus] = useState<{ text: string; kind: "" | "ok" | "error" }>({ text: "", kind: "" });
  const [running, setRunning] = useState(false);

  const st = useRef({
    callId: null as string | null,
    current: null as CurrentQuestion | null,
    history: [] as HistoryEntry[],
    running: false,
    transcriptLog,
    currentStartLen: 0,
    lastSeenLen: 0,
    lastTickedLen: 0,
    ticking: false,
    fetchingNext: false,
    advanceLockUntil: 0,
    silenceTimer: null as ReturnType<typeof setTimeout> | null,
    safetyTimer: null as ReturnType<typeof setInterval> | null,
    watcherTimer: null as ReturnType<typeof setInterval> | null,
  });

  useEffect(() => { st.current.transcriptLog = transcriptLog; }, [transcriptLog]);
  useEffect(() => { st.current.callId = callId; }, [callId]);
  useEffect(() => { st.current.current = current; }, [current]);
  useEffect(() => { st.current.history = history; }, [history]);
  useEffect(() => { st.current.running = running; }, [running]);

  // Candidate turns captured since the current question went active.
  const capturedAnswer = useCallback(() => {
    const s = st.current;
    return (s.transcriptLog || [])
      .slice(s.currentStartLen)
      .filter((t) => !isRecruiter(t.speaker))
      .map((t) => t.text)
      .join(" ")
      .trim();
  }, []);

  const fetchNext = useCallback(async (historyOverride?: HistoryEntry[]) => {
    const s = st.current;
    if (!s.callId || s.fetchingNext) return;
    s.fetchingNext = true;
    const useHistory = historyOverride || s.history;
    setStatus({ text: useHistory.length ? "Choosing the next question…" : "Designing the first question…", kind: "" });
    try {
      const data = await apiFetch<{ ok: boolean; category: string; question: string; done: boolean; error?: string }>(
        "/api/assist/next",
        { method: "POST", json: { callId: s.callId, history: useHistory } },
      );
      if (!data.ok) { setStatus({ text: data.error || "Could not get the next question.", kind: "error" }); return; }
      if (data.done || !data.question) { await finish("Enough signal — generating the final score…"); return; }
      const c: CurrentQuestion = { category: data.category || "—", question: data.question };
      setCurrent(c);
      s.current = c;
      s.currentStartLen = (s.transcriptLog || []).length;
      s.lastTickedLen = s.currentStartLen;
      s.lastSeenLen = s.currentStartLen;
      setLatest(null);
      setStatus({ text: "Live — ask the question. I'll auto-advance once they answer.", kind: "ok" });
    } catch {
      setStatus({ text: "Network error fetching the next question.", kind: "error" });
    } finally {
      s.fetchingNext = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = useCallback(async (verdict: string, feedback: string, answer: string) => {
    const s = st.current;
    s.advanceLockUntil = Date.now() + ADVANCE_LOCK_MS;
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    const entry: HistoryEntry = {
      category: s.current?.category || "",
      question: s.current?.question || "",
      answer: answer || capturedAnswer() || "",
      verdict: verdict || "Adequate",
      feedback: feedback || "",
    };
    const next = [...s.history, entry];
    setHistory(next);
    s.history = next;
    await fetchNext(next);
  }, [capturedAnswer, fetchNext]);

  const tick = useCallback(async (forced = false) => {
    const s = st.current;
    if (!s.callId || s.ticking || s.fetchingNext || !s.current || !s.running) return;
    if (Date.now() < s.advanceLockUntil) return;
    const log = s.transcriptLog || [];
    if (!forced && log.length === s.lastTickedLen) return;
    const answer = capturedAnswer();
    if (!forced && answer.length < MIN_ANSWER_CHARS) return;

    s.lastTickedLen = log.length;
    s.ticking = true;
    try {
      const data = await apiFetch<{ ok: boolean; satisfied: boolean; verdict: string; feedback: string; followUp: string; error?: string }>(
        "/api/assist/verify",
        { method: "POST", json: { callId: s.callId, question: s.current.question, answer } },
      );
      if (!data.ok) { setStatus({ text: data.error || "Verification failed.", kind: "error" }); return; }
      setLatest({
        verdict: data.verdict || (data.satisfied ? "Adequate" : "Weak"),
        kind: VERDICT_KIND[data.verdict] || (data.satisfied ? "ok" : "weak"),
        feedback: data.feedback || "",
        followUp: data.followUp || "",
        answer,
      });
      if (data.satisfied) await advance(data.verdict, data.feedback, answer);
    } catch {
      setStatus({ text: "Network error during verification.", kind: "error" });
    } finally {
      s.ticking = false;
    }
  }, [advance, capturedAnswer]);

  const watcher = useCallback(() => {
    const s = st.current;
    if (!s.running || !s.current) return;
    const log = s.transcriptLog || [];
    if (log.length === s.lastSeenLen) return;
    const newTurns = log.slice(s.lastSeenLen);
    s.lastSeenLen = log.length;
    const recruiterSpoke = newTurns.some((t) => isRecruiter(t.speaker));
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    if (recruiterSpoke) void tick();
    else s.silenceTimer = setTimeout(() => void tick(), SILENCE_MS);
  }, [tick]);

  const finish = useCallback(async (msg?: string) => {
    const s = st.current;
    setRunning(false); s.running = false;
    setCurrent(null); s.current = null;
    if (s.safetyTimer) clearInterval(s.safetyTimer);
    if (s.watcherTimer) clearInterval(s.watcherTimer);
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    setStatus({ text: msg || "Generating the final score…", kind: "" });
    if (!s.callId || !s.history.length) {
      setStatus({ text: "No questions answered yet — nothing to score.", kind: "error" });
      return;
    }
    try {
      const data = await apiFetch<FinalScore & { ok: boolean; error?: string }>("/api/assist/final", {
        method: "POST",
        json: { callId: s.callId, history: s.history },
      });
      if (!data.ok) { setStatus({ text: data.error || "Final scoring failed.", kind: "error" }); return; }
      setFinalScore(data);
      setStatus({ text: "Done — final score ready.", kind: "ok" });
    } catch {
      setStatus({ text: "Network error generating the final score.", kind: "error" });
    }
  }, []);

  const startFlow = useCallback(async (id: string) => {
    setCallId(id);
    st.current.callId = id;
    setFinalScore(null);
    setStatus({ text: "Reading the JD and candidate profile…", kind: "" });
    try {
      const data = await apiFetch<{
        ok: boolean; error?: string; fitVerdict: string; summary: string;
        strengths: string[]; gaps: string[]; categories: Array<{ name: string; questions: string[] }>;
      }>("/api/assist/plan", { method: "POST", json: { callId: id } });
      if (!data.ok) { setStatus({ text: data.error || "Could not build the interview plan.", kind: "error" }); return false; }
      setSnapshot({ fitVerdict: data.fitVerdict, summary: data.summary, strengths: data.strengths || [], gaps: data.gaps || [] });
      setPlan(data.categories || []);
    } catch {
      setStatus({ text: "Network error building the interview plan.", kind: "error" });
      return false;
    }
    setRunning(true);
    st.current.running = true;
    await fetchNext([]);
    const s = st.current;
    if (s.watcherTimer) clearInterval(s.watcherTimer);
    if (s.safetyTimer) clearInterval(s.safetyTimer);
    s.watcherTimer = setInterval(watcher, WATCH_MS);
    s.safetyTimer = setInterval(() => void tick(), SAFETY_TICK_MS);
    return true;
  }, [fetchNext, tick, watcher]);

  // --- manual recruiter overrides ---
  const markAnswered = useCallback(async () => {
    const s = st.current;
    if (!s.current || !s.running) return;
    await advance("Manually accepted", "", capturedAnswer());
  }, [advance, capturedAnswer]);

  const skip = useCallback(async () => {
    const s = st.current;
    if (!s.current || !s.running) return;
    const next = [...s.history, {
      category: s.current.category || "", question: s.current.question,
      answer: capturedAnswer() || "", verdict: "Skipped", feedback: "",
    }];
    setHistory(next); s.history = next;
    await fetchNext(next);
  }, [capturedAnswer, fetchNext]);

  const endNow = useCallback(async () => { await finish("Wrapping up — generating the final score…"); }, [finish]);
  const forceTick = useCallback(() => void tick(true), [tick]);

  // Overtake the current question with one the recruiter picked (e.g. from the
  // question bank). Becomes the active question immediately; the answer-capture
  // window resets to now, so the next candidate turns are scored against it.
  const askCustom = useCallback((question: string, category = "From bank") => {
    const s = st.current;
    if (!s.callId || !question.trim()) return;
    const c: CurrentQuestion = { category, question: question.trim() };
    setCurrent(c); s.current = c;
    s.currentStartLen = (s.transcriptLog || []).length;
    s.lastTickedLen = s.currentStartLen;
    s.lastSeenLen = s.currentStartLen;
    s.advanceLockUntil = 0;
    setLatest(null);
    if (!s.running) { setRunning(true); s.running = true; }
    setStatus({ text: "Asking your picked question — I'll verify the answer.", kind: "ok" });
  }, []);

  const reset = useCallback(() => {
    const s = st.current;
    if (s.safetyTimer) clearInterval(s.safetyTimer);
    if (s.watcherTimer) clearInterval(s.watcherTimer);
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
    Object.assign(s, {
      callId: null, current: null, history: [], running: false,
      currentStartLen: 0, lastSeenLen: 0, lastTickedLen: 0,
      ticking: false, fetchingNext: false, advanceLockUntil: 0,
      silenceTimer: null, safetyTimer: null, watcherTimer: null,
    });
    setCallId(null); setSnapshot(null); setPlan([]); setCurrent(null);
    setHistory([]); setLatest(null); setFinalScore(null);
    setStatus({ text: "", kind: "" }); setRunning(false);
  }, []);

  useEffect(() => () => {
    const s = st.current;
    if (s.safetyTimer) clearInterval(s.safetyTimer);
    if (s.watcherTimer) clearInterval(s.watcherTimer);
    if (s.silenceTimer) clearTimeout(s.silenceTimer);
  }, []);

  return {
    snapshot, plan, current, history, latest, finalScore, status, running,
    startFlow, markAnswered, skip, endNow, forceTick, reset, askCustom,
  };
}
