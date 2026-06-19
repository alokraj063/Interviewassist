// Demo-tenant-only scripted runner that simulates a full Live Assist call —
// transcript turns, sentiment ticks, suggestions, KB citations, and live
// rubric scores — without touching any real WS or audio. Drives the
// LiveAssistSetup right-rail panels off canned data so the marketing
// walkthrough has something to record without dialling a candidate.
//
// State shape intentionally mirrors `useWedgeCall().state` so the page can
// swap data sources behind a single ternary.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Citation, TranscriptTurn } from "@j2w/shared-types";
import type { Suggestion } from "@/hooks/useLiveCall";

interface LiveTranscriptTurn extends TranscriptTurn {
  uiKey: string;
}

type LiveRubric = {
  rubricId: string;
  rubricName: string;
  ts: number;
  scores: Array<{
    criterionId: string;
    score: number;
    band: "fail" | "pass" | "excellent";
    rationale: string;
  }>;
} | null;

export interface DemoRunnerState {
  status: "idle" | "live" | "ended";
  callId: string | null;
  startedAt: number | null;
  turns: LiveTranscriptTurn[];
  partial: LiveTranscriptTurn | null;
  sentiment: number;
  sentimentSeries: Array<{ t: number; v: number }>;
  suggestions: Suggestion[];
  citations: Citation[];
  liveRubric: LiveRubric;
}

const initial: DemoRunnerState = {
  status: "idle",
  callId: null,
  startedAt: null,
  turns: [],
  partial: null,
  sentiment: 50,
  sentimentSeries: [],
  suggestions: [],
  citations: [],
  liveRubric: null,
};

const DEMO_CALL_ID = "demo-live-assist-test-call";

/* ------------ Scripted timeline ------------ */

interface ScriptedTurn {
  speaker: "recruiter" | "candidate";
  text: string;
  startSec: number;
  durationSec: number;
}

// Keep total ~75 seconds of "call time" so the panels fill quickly enough
// that a recording session doesn't have to wait minutes.
const SCRIPT: ScriptedTurn[] = [
  { speaker: "recruiter", text: "Hi, am I speaking with Aarav? Main RecruitAssist se Anjali bol rahi hoon. Senior backend role ke baare mein call kar rahi thi — do you have 5 minutes?", startSec: 1, durationSec: 7 },
  { speaker: "candidate", text: "Haan haan, Aarav speaking. Bolo Anjali ji.", startSec: 8.5, durationSec: 3 },
  { speaker: "recruiter", text: "Thank you. Currently aap kahan kaam kar rahe ho aur designation kya hai?", startSec: 12, durationSec: 4 },
  { speaker: "candidate", text: "Main abhi Razorpay mein hoon, Senior Software Engineer as a backend engineer — payments team mein.", startSec: 16.5, durationSec: 6 },
  { speaker: "recruiter", text: "Got it. Aap actively looking ho na — ya casually browse kar rahe ho?", startSec: 23, durationSec: 4 },
  { speaker: "candidate", text: "Actively looking. Last 6 months mein progression kuch slow hai, isliye external opportunities dekh raha hoon.", startSec: 27.5, durationSec: 7 },
  { speaker: "recruiter", text: "Theek hai. Aapka tech stack — Java aur Spring Boot dono use karte ho?", startSec: 35, durationSec: 4 },
  { speaker: "candidate", text: "Java + Spring Boot mainly, plus Kafka for async. PostgreSQL is the primary DB. Some AWS — EKS, RDS, SQS.", startSec: 39.5, durationSec: 8 },
  { speaker: "recruiter", text: "Perfect alignment hai. Aapka current CTC kya hai roughly — fixed component?", startSec: 48, durationSec: 5 },
  { speaker: "candidate", text: "Fixed 28 lakhs hai, plus 4 lakh variable. Total around 32 LPA.", startSec: 53.5, durationSec: 5 },
  { speaker: "recruiter", text: "Aur expectation kya rakh rahe ho?", startSec: 59, durationSec: 3 },
  { speaker: "candidate", text: "Looking at 40-45 fixed at minimum. Variable on top.", startSec: 62.5, durationSec: 4 },
  { speaker: "recruiter", text: "Note kar liya. Notice period kitna hai aapka?", startSec: 67, durationSec: 4 },
  { speaker: "candidate", text: "60 days hai officially, but maybe negotiable to 30-45 if buyout option there.", startSec: 71.5, durationSec: 6 },
];

const TOTAL_SCRIPT_SEC = SCRIPT[SCRIPT.length - 1].startSec + SCRIPT[SCRIPT.length - 1].durationSec + 2;

// Run-time compression so the demo lands quickly on screen.
// 1 sec wall = COMPRESSION sec call-time.
// Higher = faster wall-clock playback (turns + suggestions land sooner).
const COMPRESSION = 3.0;

interface ScheduledSuggestion {
  atSec: number; // wall-clock seconds after start
  suggestion: Suggestion;
  citations: Citation[];
}

const DEMO_CITATIONS: Citation[] = [
  {
    chunkId: 980001,
    sourceId: "src-acme-culture",
    sourceName: "Acme GCC engineering culture",
    documentId: "doc-acme-engineering",
    documentTitle: "Engineering values + on-call expectations",
    snippet: "Hybrid model: minimum 3 days/week in office for L4-L5 engineers. Remote-only allowed for staff and above with team approval.",
    score: 0.88,
  },
  {
    chunkId: 980002,
    sourceId: "src-jd-library",
    sourceName: "Client JD library",
    documentId: "doc-senior-java-jd",
    documentTitle: "Senior Java Backend — Acme GCC India",
    snippet: "Senior Java Backend Engineer. 5-9 years exp. Salary band ₹22-38 LPA fixed + variable. Must have: Java, Spring Boot, microservices.",
    score: 0.84,
  },
  {
    chunkId: 980003,
    sourceId: "src-hiring-sop",
    sourceName: "Hiring SOP",
    documentId: "doc-recruiter-playbook",
    documentTitle: "End-to-end recruiter playbook",
    snippet: "Once aligned on CTC + notice + location, recruiter promotes prospect to submission. Internal review by delivery lead before client_submit.",
    score: 0.79,
  },
  {
    chunkId: 980004,
    sourceId: "src-jbank",
    sourceName: "Java + Spring Boot interview prep",
    documentId: "doc-java-questions",
    documentTitle: "Senior Java backend question pool",
    snippet: "When discussing JVM concurrency, expect coverage of volatile / synchronized / CAS primitives, ConcurrentHashMap internals, and Java 21 virtual threads vs platform threads.",
    score: 0.72,
  },
];

function buildSuggestion(args: {
  id: string;
  triggerTurnId: number;
  text: string;
  topics?: string[];
  flags?: string[];
  citations?: Citation[];
  confidence?: number;
  latencyMs?: number;
}): Suggestion {
  return {
    requestId: args.id,
    triggerTurnId: args.triggerTurnId,
    // Set both `text` (raw OpenAI JSON-string mode) and `payload` (parsed
    // mode). The card prefers `payload.suggestion` when `done=true`, so
    // populating payload guarantees rendered prose instead of "Thinking…".
    text: JSON.stringify({
      suggestion: args.text,
      sentiment: 0.2,
      topics: args.topics ?? [],
      complianceFlags: args.flags ?? [],
      citations: args.citations ?? [],
      confidence: args.confidence ?? 0.8,
    }),
    payload: {
      suggestion: args.text,
      sentiment: 0.2,
      topics: args.topics ?? [],
      complianceFlags: args.flags ?? [],
      citations: args.citations ?? [],
      confidence: args.confidence ?? 0.8,
    },
    done: true,
    latencyMs: args.latencyMs ?? 1100,
  };
}

const SCHEDULED_SUGGESTIONS: ScheduledSuggestion[] = [
  {
    atSec: 5,
    suggestion: buildSuggestion({
      id: "demo-sug-1",
      triggerTurnId: 2,
      text: "Open with a soft confirm — confirm name and ask permission for 5 minutes. Aarav agreed quickly, so move to qualification within 30 seconds.",
      topics: ["intro", "permission"],
      confidence: 0.86,
      latencyMs: 920,
    }),
    citations: [],
  },
  {
    atSec: 17,
    suggestion: buildSuggestion({
      id: "demo-sug-2",
      triggerTurnId: 4,
      text: "Razorpay payments team — strong fintech fit. Probe scope of ownership next: which sub-system did he own end-to-end?",
      topics: ["fintech fit", "ownership"],
      citations: [DEMO_CITATIONS[1]],
      confidence: 0.81,
      latencyMs: 1120,
    }),
    citations: [DEMO_CITATIONS[1]],
  },
  {
    atSec: 30,
    suggestion: buildSuggestion({
      id: "demo-sug-3",
      triggerTurnId: 6,
      text: "Active seeker + clear push factor (slow progression). High intent. Don't over-pitch — confirm stack alignment, then move to compensation and notice.",
      topics: ["intent", "active-seeker"],
      citations: [DEMO_CITATIONS[2]],
      confidence: 0.84,
      latencyMs: 980,
    }),
    citations: [DEMO_CITATIONS[2]],
  },
  {
    atSec: 45,
    suggestion: buildSuggestion({
      id: "demo-sug-4",
      triggerTurnId: 8,
      text: "Stack matches must-haves: Java, Spring Boot, Kafka, AWS. State the band up front and don't anchor low.",
      topics: ["stack-fit", "compensation"],
      citations: [DEMO_CITATIONS[1], DEMO_CITATIONS[3]],
      confidence: 0.88,
      latencyMs: 1210,
    }),
    citations: [DEMO_CITATIONS[1], DEMO_CITATIONS[3]],
  },
  {
    atSec: 62,
    suggestion: buildSuggestion({
      id: "demo-sug-5",
      triggerTurnId: 10,
      text: "Candidate ask is above the demand cap. Probe stretch: variable or sign-on acceptable to bridge?",
      topics: ["comp gap", "negotiation"],
      flags: ["compensation_gap"],
      citations: [DEMO_CITATIONS[1]],
      confidence: 0.74,
      latencyMs: 1080,
    }),
    citations: [DEMO_CITATIONS[1]],
  },
  {
    atSec: 74,
    suggestion: buildSuggestion({
      id: "demo-sug-6",
      triggerTurnId: 13,
      text: "Notice flexible with buyout — within demand window. Confirm next step: full JD over email, schedule L1 within 48h.",
      topics: ["notice", "next-step"],
      citations: [DEMO_CITATIONS[2]],
      confidence: 0.83,
      latencyMs: 940,
    }),
    citations: [DEMO_CITATIONS[2]],
  },
];

interface ScheduledRubricTick {
  atSec: number;
  scores: LiveRubric extends { scores: infer S } ? S : never;
}

const RUBRIC_TICKS: ScheduledRubricTick[] = [
  {
    atSec: 18,
    scores: [
      { criterionId: "script_adherence", score: 78, band: "pass", rationale: "Greeted, confirmed name, asked permission for time. Standard opener." },
      { criterionId: "jd_coverage", score: 60, band: "pass", rationale: "Identified current company and role; not yet probed must-have skills." },
      { criterionId: "salary_handling", score: 50, band: "pass", rationale: "Compensation discussion not yet started." },
      { criterionId: "positioning", score: 55, band: "pass", rationale: "Mentioned senior backend role; client name not yet introduced." },
      { criterionId: "candidate_experience", score: 80, band: "pass", rationale: "Allowed candidate space to respond. No interruptions." },
    ],
  },
  {
    atSec: 38,
    scores: [
      { criterionId: "script_adherence", score: 82, band: "pass", rationale: "Steady flow through current company → active-seeker check → tech stack." },
      { criterionId: "jd_coverage", score: 78, band: "pass", rationale: "Probed Java + Spring Boot must-haves. Candidate confirmed strong alignment." },
      { criterionId: "salary_handling", score: 50, band: "pass", rationale: "Compensation discussion approaching." },
      { criterionId: "positioning", score: 60, band: "pass", rationale: "Industry context implied; explicit role positioning still pending." },
      { criterionId: "candidate_experience", score: 84, band: "pass", rationale: "Candidate confidence rising. Open-ended responses encouraged." },
    ],
  },
  {
    atSec: 60,
    scores: [
      { criterionId: "script_adherence", score: 86, band: "excellent", rationale: "Smooth transition into compensation handling." },
      { criterionId: "jd_coverage", score: 84, band: "pass", rationale: "Stack alignment confirmed (Java, Spring Boot, Kafka, AWS)." },
      { criterionId: "salary_handling", score: 72, band: "pass", rationale: "Captured current CTC cleanly. Expectations gathered without pressure." },
      { criterionId: "positioning", score: 64, band: "pass", rationale: "Could position the role's growth narrative more deliberately." },
      { criterionId: "candidate_experience", score: 88, band: "excellent", rationale: "Calm, conversational. Candidate still engaged at 60s." },
    ],
  },
  {
    atSec: 78,
    scores: [
      { criterionId: "script_adherence", score: 88, band: "excellent", rationale: "All five must-capture data points covered. Notice period elicited cleanly." },
      { criterionId: "jd_coverage", score: 86, band: "excellent", rationale: "Stack confirmed; comp + notice + location all logged." },
      { criterionId: "salary_handling", score: 70, band: "pass", rationale: "Gap surfaced (38 cap vs 40-45 ask). Recruiter to discuss stretch options." },
      { criterionId: "positioning", score: 68, band: "pass", rationale: "Recruiter signalled fit; explicit team/scale colour could be stronger." },
      { criterionId: "candidate_experience", score: 90, band: "excellent", rationale: "Candidate engaged throughout; volunteered notice flexibility." },
    ],
  },
];

/* ------------ Sentiment shape ------------ */

function sentimentAt(sec: number): number {
  // Start neutral (50), rise as candidate confirms interest, slight dip
  // around comp gap, recover toward end as notice flexibility surfaces.
  if (sec < 5) return 50 + Math.round(sec * 1.5);
  if (sec < 25) return 60 + Math.round((sec - 5) * 0.7);
  if (sec < 50) return 73 + Math.round(Math.sin((sec - 25) / 5) * 4);
  if (sec < 60) return 75 - Math.round((sec - 50) * 0.6); // dip during comp gap
  if (sec < 75) return 70 + Math.round((sec - 60) * 0.6);
  return 78;
}

/* ------------ The hook ------------ */

export function useDemoLiveAssistRunner() {
  const [state, setState] = useState<DemoRunnerState>(initial);
  const timersRef = useRef<number[]>([]);
  const sentimentTickRef = useRef<number | null>(null);

  const clearAll = useCallback(() => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
    if (sentimentTickRef.current != null) {
      window.clearInterval(sentimentTickRef.current);
      sentimentTickRef.current = null;
    }
  }, []);

  useEffect(() => () => clearAll(), [clearAll]);

  const start = useCallback(() => {
    clearAll();
    const startedAt = Date.now();
    setState({
      ...initial,
      status: "live",
      callId: DEMO_CALL_ID,
      startedAt,
    });

    let idCounter = 1;

    // Schedule transcript turns. Each turn animates as a partial first
    // (showing the streaming behaviour), then promotes to a final.
    SCRIPT.forEach((turn) => {
      const wallStartMs = (turn.startSec / COMPRESSION) * 1000;
      const wallEndMs = ((turn.startSec + turn.durationSec) / COMPRESSION) * 1000;

      // Partial appears mid-utterance.
      const partialAt = wallStartMs + (wallEndMs - wallStartMs) * 0.35;
      timersRef.current.push(
        window.setTimeout(() => {
          setState((s) => ({
            ...s,
            partial: {
              id: -1,
              callId: DEMO_CALL_ID,
              speaker: turn.speaker,
              text: turn.text.slice(0, Math.max(8, Math.floor(turn.text.length * 0.55))) + "…",
              isFinal: false,
              tsStartMs: turn.startSec * 1000,
              tsEndMs: turn.startSec * 1000 + 200,
              sentiment: 0.1,
              uiKey: `partial:${turn.startSec}`,
            },
          }));
        }, partialAt),
      );

      // Final lands at end of utterance, replacing the partial and appending.
      timersRef.current.push(
        window.setTimeout(() => {
          const id = idCounter++;
          setState((s) => ({
            ...s,
            partial: null,
            turns: [
              ...s.turns,
              {
                id,
                callId: DEMO_CALL_ID,
                speaker: turn.speaker,
                text: turn.text,
                isFinal: true,
                tsStartMs: turn.startSec * 1000,
                tsEndMs: (turn.startSec + turn.durationSec) * 1000,
                sentiment: turn.speaker === "candidate" ? 0.3 : 0.4,
                uiKey: `final:${id}`,
              },
            ],
          }));
        }, wallEndMs),
      );
    });

    // Schedule suggestions.
    SCHEDULED_SUGGESTIONS.forEach((sched) => {
      const wallMs = (sched.atSec / COMPRESSION) * 1000;
      timersRef.current.push(
        window.setTimeout(() => {
          setState((s) => ({
            ...s,
            suggestions: [sched.suggestion, ...s.suggestions].slice(0, 8),
            citations: dedupeCitations([...sched.citations, ...s.citations]),
          }));
        }, wallMs),
      );
    });

    // Schedule rubric ticks.
    RUBRIC_TICKS.forEach((tick) => {
      const wallMs = (tick.atSec / COMPRESSION) * 1000;
      timersRef.current.push(
        window.setTimeout(() => {
          setState((s) => ({
            ...s,
            liveRubric: {
              rubricId: "demo-rubric-general",
              rubricName: "General Screening",
              ts: Date.now(),
              scores: tick.scores,
            },
          }));
        }, wallMs),
      );
    });

    // Sentiment series ticks at 1Hz wall-clock; each tick advances call-time
    // by COMPRESSION seconds.
    let elapsed = 0;
    sentimentTickRef.current = window.setInterval(() => {
      elapsed += COMPRESSION;
      const v = sentimentAt(elapsed);
      setState((s) => {
        const last = s.sentimentSeries.length > 0 ? s.sentimentSeries[s.sentimentSeries.length - 1].t : -1;
        const t = last + 1;
        return {
          ...s,
          sentiment: v,
          sentimentSeries: [...s.sentimentSeries.slice(-47), { t, v }],
        };
      });
    }, 1000);

    // End the call automatically a couple of seconds after the last turn.
    const endAt = (TOTAL_SCRIPT_SEC / COMPRESSION) * 1000 + 1500;
    timersRef.current.push(
      window.setTimeout(() => {
        setState((s) => ({ ...s, status: "ended" }));
        if (sentimentTickRef.current != null) {
          window.clearInterval(sentimentTickRef.current);
          sentimentTickRef.current = null;
        }
      }, endAt),
    );
  }, [clearAll]);

  const end = useCallback(() => {
    clearAll();
    setState((s) => ({ ...s, status: "ended" }));
  }, [clearAll]);

  const reset = useCallback(() => {
    clearAll();
    setState(initial);
  }, [clearAll]);

  return { state, start, end, reset };
}

function dedupeCitations(arr: Citation[]): Citation[] {
  const seen = new Set<number>();
  const out: Citation[] = [];
  for (const c of arr) {
    if (seen.has(c.chunkId)) continue;
    seen.add(c.chunkId);
    out.push(c);
    if (out.length >= 12) break;
  }
  return out;
}
