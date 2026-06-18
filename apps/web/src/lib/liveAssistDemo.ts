// Seed data for the Live Assist page when no call is in progress.
// Scenario: HP Pavilion 15 owner whose laptop won't boot after a BIOS update.
import type { Citation, TranscriptTurn } from "@j2w/shared-types";
import type { Suggestion } from "@/hooks/useLiveCall";

export interface DemoCustomer {
  name: string;
  accountId: string;
  product: string;
  warranty: string;
  location: string;
  phone: string;
  email: string;
  priorTickets: Array<{ id: string; subject: string; date: string }>;
  tags: string[];
}

const DEMO_CALL_ID = "demo-hp-laptop";

export const demoCustomer: DemoCustomer = {
  name: "Rahul Verma",
  accountId: "ACC-90821",
  product: "HP Pavilion 15-eh1xxx",
  warranty: "Active · expires 2026-11-03",
  location: "Pune, Maharashtra",
  phone: "+91 98•• •12345",
  email: "rahul.verma@example.com",
  priorTickets: [
    { id: "INC-44219", subject: "Battery draining fast", date: "2026-02-11" },
    { id: "INC-46102", subject: "BIOS update prompt loop", date: "2026-03-28" },
  ],
  tags: ["Priority", "Repeat caller"],
};

export const demoTurns: TranscriptTurn[] = [
  {
    id: 1,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Hi, mera HP Pavilion laptop start hi nahi ho raha. Power light aati hai, but screen blank rehta hai.",
    isFinal: true,
    tsStartMs: 0,
    tsEndMs: 5200,
    sentiment: -0.55,
  },
  {
    id: 2,
    callId: DEMO_CALL_ID,
    speaker: "recruiter",
    text: "Bahut sorry sunke, Rahul ji. Main turant help karunga. Aap last kab normally use kar paaye the?",
    isFinal: true,
    tsStartMs: 5400,
    tsEndMs: 11000,
    sentiment: 0.1,
  },
  {
    id: 3,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Last raat tak theek tha. Subah BIOS update ka prompt aaya, install karne ke baad ab boot nahi ho raha.",
    isFinal: true,
    tsStartMs: 11500,
    tsEndMs: 18000,
    sentiment: -0.5,
  },
  {
    id: 4,
    callId: DEMO_CALL_ID,
    speaker: "recruiter",
    text: "Samjh gaya. BIOS update ke baad hard reset kaafi baar kaam karta hai. Aapka data safe rahega, worry mat kijiye.",
    isFinal: true,
    tsStartMs: 18500,
    tsEndMs: 25000,
    sentiment: 0.25,
  },
  {
    id: 5,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Battery toh non-removable hai. Main kya karu exactly?",
    isFinal: true,
    tsStartMs: 25400,
    tsEndMs: 29000,
    sentiment: -0.2,
  },
  {
    id: 6,
    callId: DEMO_CALL_ID,
    speaker: "recruiter",
    text: "Power cable nikaaliye, fir power button 30 seconds tak press karke hold kariye. Residual charge drain ho jayega. Phir cable laga ke boot try kariye.",
    isFinal: true,
    tsStartMs: 29200,
    tsEndMs: 38000,
    sentiment: 0.2,
  },
  {
    id: 7,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Okay, try karta hoon. Thoda wait kariye.",
    isFinal: true,
    tsStartMs: 38200,
    tsEndMs: 41500,
    sentiment: 0.05,
  },
  {
    id: 8,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Haan! Ab screen aa gayi. Thank you so much. Warranty period mein hai na, agar future mein aise hua?",
    isFinal: true,
    tsStartMs: 58000,
    tsEndMs: 64500,
    sentiment: 0.65,
  },
];

// 18-point curve: dips early (customer frustrated) then recovers (fix works).
export const demoSentimentSeries: Array<{ t: number; v: number }> = (() => {
  const out: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < 18; i++) {
    const phase = i / 17;
    const dip = 55 - 32 * Math.exp(-((phase - 0.22) ** 2) / 0.035);
    const recover = phase > 0.55 ? (phase - 0.55) * 55 : 0;
    const v = Math.round(Math.max(18, Math.min(82, dip + recover)));
    out.push({ t: i, v });
  }
  return out;
})();

export const demoSentiment = demoSentimentSeries[demoSentimentSeries.length - 1].v;

export const demoCitations: Citation[] = [
  {
    chunkId: 900001,
    sourceId: "src-hp-kb",
    sourceName: "HP Support KB",
    documentId: "doc-bios-reset",
    documentTitle: "HP Notebook BIOS recovery / reset",
    snippet:
      "Disconnect AC adapter, press and hold the Power button for 30 seconds to drain residual charge, then reconnect and boot. Use the BIOS reset pinhole if reset fails.",
    score: 0.91,
  },
  {
    chunkId: 900002,
    sourceId: "src-hp-kb",
    sourceName: "HP Support KB",
    documentId: "doc-pavilion15-thermal",
    documentTitle: "HP Pavilion 15 thermal shutdown triage",
    snippet:
      "Thermal shutdowns on Pavilion 15 often correlate with blocked intake vents or failed TIM after ~2 years. Check fan RPM via HP PC Hardware Diagnostics.",
    score: 0.78,
  },
  {
    chunkId: 900003,
    sourceId: "src-j2w-warranty",
    sourceName: "J2W Warranty Ops",
    documentId: "doc-warranty-lookup",
    documentTitle: "Warranty lookup & replacement triggers",
    snippet:
      "Replacement qualifies if the unit is under 14 months old AND two prior incidents of the same root cause are logged within 30 days.",
    score: 0.72,
  },
];

export const demoSuggestions: Suggestion[] = [
  {
    requestId: "demo-sug-1",
    triggerTurnId: 3,
    text:
      "Walk Rahul through the HP hard-reset: unplug AC, hold Power for 30 seconds, reconnect and boot. Reassure him no data is lost — he sounded worried about the BIOS update.",
    payload: {
      suggestion:
        "Walk Rahul through the HP hard-reset: unplug AC, hold Power for 30 seconds, reconnect and boot. Reassure him no data is lost.",
      sentiment: -0.4,
      topics: ["BIOS update", "Boot failure", "HP Pavilion"],
      complianceFlags: [],
      citations: [demoCitations[0]],
      confidence: 0.82,
    },
    latencyMs: 1240,
    done: true,
  },
];

export const demoTopics: Array<{ name: string; confidence: number }> = [
  { name: "BIOS update", confidence: 0.88 },
  { name: "Boot failure", confidence: 0.81 },
  { name: "HP Pavilion 15", confidence: 0.74 },
  { name: "Warranty check", confidence: 0.42 },
];

export const demoCompliance: Array<{
  id: string;
  label: string;
  ok: boolean;
  ts?: number;
}> = [
  { id: "disclosure", label: "Recording disclosure", ok: true, ts: 3_200 },
  { id: "identity", label: "Identity verified", ok: true, ts: 8_500 },
  { id: "fees", label: "Fee disclosure", ok: false },
];

// Rough elapsed from the last turn tsEnd; makes the duration readout look live.
export const demoElapsedSec = Math.floor(
  demoTurns[demoTurns.length - 1].tsEndMs / 1000,
);

export interface LiveAssistSeed {
  turns: TranscriptTurn[];
  sentimentSeries: Array<{ t: number; v: number }>;
  sentiment: number;
  topics: Array<{ name: string; confidence: number }>;
  compliance: Array<{ id: string; label: string; ok: boolean; ts?: number }>;
  suggestions: Suggestion[];
  citations: Citation[];
  elapsed: number;
}

export const liveAssistDemoSeed: LiveAssistSeed = {
  turns: demoTurns,
  sentimentSeries: demoSentimentSeries,
  sentiment: demoSentiment,
  topics: demoTopics,
  compliance: demoCompliance,
  suggestions: demoSuggestions,
  citations: demoCitations,
  elapsed: demoElapsedSec,
};
