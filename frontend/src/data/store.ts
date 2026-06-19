import { Agent, CoachingAssignment, Conversation, CriterionResult, IssueCategory, KBSource, Notification, Outcome, Scorecard, ScorecardCriterion, Sentiment, Team, TrainingModule, TranscriptTurn, User, VoiceAgent, ActivityEvent } from "./types";
import { chance, pick, pickN, rand, randInt, resetRng } from "./rng";

resetRng(20240101);

// ---------- Teams ----------
// J2W-style recruiter pods. The IDs are kept stable so existing UI code
// (which references them via getTeam) keeps working.
export const TEAMS: Team[] = [
  { id: "team-billing", name: "GCC Hiring Pod 1", managerId: "agt-3" },
  { id: "team-tech", name: "Tech Sourcing — North", managerId: "agt-2" },
  { id: "team-account", name: "Premium Accounts Pod", managerId: "agt-7" },
  { id: "team-retention", name: "Engineering Roles — Bangalore", managerId: "agt-9" },
  { id: "team-premier", name: "Strategic GCC Cell", managerId: "agt-12" },
];

// ---------- Recruiters ----------
const AGENT_NAMES = [
  ["Priya Sharma", "Mumbai, IN"],
  ["Rohan Mehta", "Bengaluru, IN"],
  ["Aisha Patel", "Pune, IN"],
  ["Karan Singh", "Gurugram, IN"],
  ["Neha Iyer", "Chennai, IN"],
  ["Rajesh Kumar", "Bengaluru, IN"],
  ["Sneha O'Brien", "Hyderabad, IN"],
  ["Vikram Tanaka", "Mumbai, IN"],
  ["Fatima Al-Hassan", "Noida, IN"],
  ["Arjun Reyes", "Bengaluru, IN"],
  ["Linh Nguyen", "Pune, IN"],
  ["Ananya Bennett", "Hyderabad, IN"],
];
// IssueCategory values are reused as recruiter-relevant criteria buckets:
//   Identification -> "JD Coverage"
//   Resolution     -> "Salary Handling"
//   Escalation     -> "Notice Period"
//   Compliance     -> "Script Adherence"
//   Empathy        -> "Candidate Experience"
//   Process        -> "Technical Depth"
const ALL_CATEGORIES: IssueCategory[] = ["Identification", "Resolution", "Escalation", "Compliance", "Empathy", "Process"];

function makeSpark(base: number, len = 14): number[] {
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < len; i++) {
    v += rand(-4, 4);
    v = Math.max(40, Math.min(98, v));
    out.push(Math.round(v));
  }
  return out;
}

export const AGENTS: Agent[] = AGENT_NAMES.map(([name, region], i) => {
  const teamId = TEAMS[i % TEAMS.length].id;
  const avg = randInt(62, 94);
  const initials = name.split(" ").map(p => p[0]).slice(0, 2).join("");
  return {
    id: `agt-${i + 1}`,
    name,
    email: name.toLowerCase().replace(/[^a-z]/g, ".") + "@recruitassist.local",
    initials,
    role: i === 11 ? "Manager" : i === 6 ? "Manager" : i === 2 ? "Team Lead" : "Agent",
    teamId,
    tenureMonths: randInt(3, 96),
    region,
    avgScore: avg,
    callsHandled7d: randInt(38, 142),
    callsHandled30d: randInt(180, 620),
    weaknesses: pickN(ALL_CATEGORIES, randInt(1, 2)),
    openCoaching: randInt(0, 4),
    trend: Math.round(rand(-8, 10)),
    scoreSpark: makeSpark(avg),
    status: chance(0.45) ? "in_call" : chance(0.4) ? "active" : chance(0.5) ? "away" : "offline",
  };
});

// Alias for new code that wants the recruiter-flavored name. Existing
// consumers continue to import AGENTS unchanged.
export const RECRUITERS = AGENTS;

export const CURRENT_USER: Agent = {
  id: "me",
  name: "Daniel Dsouza",
  email: "daniel.dsouza@recruitassist.local",
  initials: "DD",
  role: "Admin",
  teamId: "team-premier",
  tenureMonths: 38,
  region: "Mumbai, IN",
  avgScore: 91,
  callsHandled7d: 0,
  callsHandled30d: 0,
  weaknesses: [],
  openCoaching: 2,
  trend: 0,
  scoreSpark: makeSpark(91),
  status: "active",
};

// ---------- Rubrics (still typed as Scorecard for backward compat) ----------
const CRITERIA_BANK: Omit<ScorecardCriterion, "id">[] = [
  { name: "Confirmed candidate identity & current role", description: "Verified the candidate's identity, current employer, and current designation before discussing the demand.", weight: 8, passThreshold: 70, severity: "high", category: "Compliance" },
  { name: "Acknowledged candidate's situation early", description: "Acknowledged the candidate's current career goals or constraints in the first 60 seconds.", weight: 10, passThreshold: 75, severity: "medium", category: "Empathy" },
  { name: "JD positioning clear", description: "Clearly explained the role, the client, the team, and why the candidate fits — avoided generic pitches.", weight: 18, passThreshold: 80, severity: "high", category: "Identification" },
  { name: "Salary range discussed with rationale", description: "Stated the demand's salary range and the rationale (band, internal equity), not just a number.", weight: 14, passThreshold: 75, severity: "high", category: "Resolution" },
  { name: "Mandatory disclosures completed", description: "Covered required disclosures: client name (if shareable), location, work-from-office expectation, mandatory checks.", weight: 12, passThreshold: 90, severity: "critical", category: "Compliance" },
  { name: "Notice period probed and validated", description: "Asked about notice period, negotiability, and any garden-leave constraints.", weight: 12, passThreshold: 70, severity: "high", category: "Escalation" },
  { name: "Asked at least 3 technical probing questions", description: "For technical screens: asked at least three questions tied to the must-have skills with reasonable depth.", weight: 16, passThreshold: 70, severity: "high", category: "Process" },
  { name: "Closed with clear next steps & ETA", description: "Summarised the conversation, stated next step (submission / next call / pause), and gave a date.", weight: 10, passThreshold: 70, severity: "low", category: "Process" },
];

function buildCriteria(picks: number[]): ScorecardCriterion[] {
  return picks.map((idx) => ({ id: `crit-${idx}`, ...CRITERIA_BANK[idx] }));
}

export const SCORECARDS: Scorecard[] = [
  { id: "sc-billing", name: "General Recruiter Screen", description: "Default rubric for first-touch recruiter calls.", appliesTo: "Stage: Initial outreach", active: true, criteria: buildCriteria([0, 1, 2, 3, 5, 7]), modified: "2026-04-12", timesUsed: 4218 },
  { id: "sc-tech", name: "Technical Screen", description: "Rubric for technical depth screening calls.", appliesTo: "Stage: Technical screen", active: true, criteria: buildCriteria([0, 2, 3, 6, 5, 7]), modified: "2026-04-08", timesUsed: 3641 },
  { id: "sc-retention", name: "Senior Hiring Rubric", description: "Higher-bar rubric for senior / staff roles.", appliesTo: "Seniority: Senior+", active: true, criteria: buildCriteria([0, 2, 3, 4, 6, 5]), modified: "2026-04-02", timesUsed: 1109 },
  { id: "sc-compliance", name: "Compliance-Critical (Regulated)", description: "Stricter rubric for BFSI/regulated client demands.", appliesTo: "Industry: BFSI, Healthcare", active: true, criteria: buildCriteria([0, 4, 2, 3, 5]), modified: "2026-04-15", timesUsed: 892 },
  { id: "sc-baseline", name: "New Recruiter Baseline", description: "Lighter rubric for recruiters in their first 90 days.", appliesTo: "Tenure < 90 days", active: true, criteria: buildCriteria([0, 1, 2, 5, 7]), modified: "2026-03-28", timesUsed: 2204 },
  { id: "sc-premier", name: "Premier Client Engagement", description: "High-touch rubric for VIP / strategic GCC clients.", appliesTo: "Client tier: Strategic", active: true, criteria: buildCriteria([1, 2, 3, 4, 6, 7]), modified: "2026-04-01", timesUsed: 587 },
];

// ---------- Coaching modules ----------
export const TRAINING: TrainingModule[] = [
  { id: "tr-1", title: "Compensation conversation framing", description: "Walk a candidate through CTC discussion when there's a 30%+ gap, without losing them.", triggerCriterion: "Salary range discussed with rationale", duration: 18, timesAssigned: 142, completionRate: 87, postImprovement: 23, severity: "high", category: "Resolution", simulationId: "sim-1" },
  { id: "tr-2", title: "Improve technical question depth", description: "Five-question framework to probe Java/Python/SQL beyond surface-level answers.", triggerCriterion: "Asked at least 3 technical probing questions", duration: 25, timesAssigned: 211, completionRate: 91, postImprovement: 31, severity: "high", category: "Process", simulationId: "sim-2" },
  { id: "tr-3", title: "Notice period objection handling", description: "Handle 90-day notice period objections; surface real flexibility (buyout, garden leave, partial notice).", triggerCriterion: "Notice period probed and validated", duration: 22, timesAssigned: 178, completionRate: 84, postImprovement: 19, severity: "high", category: "Escalation", simulationId: "sim-3" },
  { id: "tr-4", title: "Mandatory disclosures for regulated clients", description: "Cover required disclosures (BGV, drug test, location lock-in, work-from-office) without sounding scripted.", triggerCriterion: "Mandatory disclosures completed", duration: 14, timesAssigned: 97, completionRate: 95, postImprovement: 41, severity: "critical", category: "Compliance", simulationId: "sim-4" },
  { id: "tr-5", title: "Establishing identity and current role quickly", description: "Verify identity and current designation in under a minute while staying conversational.", triggerCriterion: "Confirmed candidate identity & current role", duration: 12, timesAssigned: 134, completionRate: 92, postImprovement: 28, severity: "high", category: "Compliance", simulationId: "sim-5" },
  { id: "tr-6", title: "JD positioning that stops generic pitches", description: "Pitch the role using the client's tech stack and team context — not a copy-pasted JD.", triggerCriterion: "JD positioning clear", duration: 16, timesAssigned: 88, completionRate: 89, postImprovement: 17, severity: "medium", category: "Identification", simulationId: "sim-6" },
  { id: "tr-7", title: "Active listening for Hinglish calls", description: "Verbal acknowledgement patterns when the candidate switches between English and Hindi.", triggerCriterion: "Acknowledged candidate's situation early", duration: 20, timesAssigned: 64, completionRate: 81, postImprovement: 14, severity: "medium", category: "Empathy", simulationId: "sim-7" },
  { id: "tr-8", title: "Call wrap that drives submission velocity", description: "Confirmation pattern that cuts callback rate and keeps prospect-to-submission time below 48h.", triggerCriterion: "Closed with clear next steps & ETA", duration: 10, timesAssigned: 119, completionRate: 93, postImprovement: 22, severity: "low", category: "Process", simulationId: "sim-8" },
  { id: "tr-9", title: "Recognising client-feedback escalations", description: "Five signals that a candidate is about to ghost — escalate to delivery lead before it happens.", triggerCriterion: "Notice period probed and validated", duration: 15, timesAssigned: 73, completionRate: 79, postImprovement: 26, severity: "high", category: "Escalation", simulationId: "sim-9" },
  { id: "tr-10", title: "Reading the candidate — passive vs active", description: "Detect whether the candidate is actively looking or just exploring, and adjust pitch accordingly.", triggerCriterion: "JD positioning clear", duration: 28, timesAssigned: 51, completionRate: 86, postImprovement: 33, severity: "medium", category: "Identification", simulationId: "sim-10" },
];

// ---------- Calls (still typed as Conversation for backward compat) ----------
const INTENTS = [
  "Java backend role discussion", "Notice period objection", "CTC negotiation", "Initial interest gauge",
  "Technical screen — Java", "Technical screen — Python", "Technical screen — React",
  "Re-engagement call", "Location concern handling", "Final-round preparation",
  "Counter-offer scenario", "JD walkthrough", "Client positioning", "Reference check coordination",
  "Onboarding handoff",
];
const FIRST_NAMES = ["Aarti", "Vikram", "Rahul", "Pooja", "Suresh", "Meera", "Anand", "Priyanka", "Karthik", "Divya", "Aniket", "Sanjana", "Manish", "Ritika", "Akshay", "Nidhi", "Kunal", "Tanvi"];
const LAST_INITIALS = ["S.", "R.", "K.", "M.", "G.", "B.", "P.", "C.", "T.", "J."];

const CANDIDATE_LINES_OPEN = [
  "Haan, hi, batao — I got your message about the role.",
  "Hi, yes I'm currently a Senior Engineer at Infosys, looking out actively.",
  "Bolo bolo, I have 10 minutes before my next standup.",
  "Sorry I missed the earlier call. What's the role about?",
];
const RECRUITER_LINES_OPEN = [
  "Thank you for taking the call, this is {name} from RecruitAssist. Quick question to start — could you confirm your current company and designation, please?",
  "Hi, you're speaking with {name}. I'm reaching out about a Senior Backend role with one of our strategic clients in Bengaluru. Is this a good time for a 10-minute conversation?",
];
const RECRUITER_LINES_EMPATHY = [
  "Got it. So you've been at Infosys for 6 years on the payments platform — that's exactly the background this role is looking for. Let me walk you through the demand and then we can see if it makes sense for you.",
  "Understood, you're looking for senior engineering ownership and a clearer growth path. The role I have in mind has both — let me explain.",
];
const CANDIDATE_LINES_FOLLOWUP = [
  "What's the CTC range you're working with? My current is 18 LPA and I'm expecting 28 to 32.",
  "And what about notice period? Mine is 60 days, can be reduced to 30 with buyout.",
  "Is this fully work from office? Because I'm based out of Hyderabad currently.",
  "How many rounds of interviews are there? I've burned out doing 6 rounds at the last place.",
];

function buildTranscript(agentName: string, customerName: string, durationSec: number): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let t = 0;
  function ts(sec: number) {
    const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  // opening
  t += randInt(2, 5);
  turns.push({ speaker: "customer", speakerName: customerName, ts: ts(t), text: pick(CANDIDATE_LINES_OPEN), sentiment: "neutral" });
  t += randInt(8, 14);
  turns.push({ speaker: "agent", speakerName: agentName, ts: ts(t), text: pick(RECRUITER_LINES_OPEN).replace("{name}", agentName.split(" ")[0]), criterion: "Confirmed candidate identity & current role" });
  t += randInt(10, 18);
  turns.push({ speaker: "customer", speakerName: customerName, ts: ts(t), text: "I'm a Senior Engineer at Infosys, total 6.2 years, currently working on the payments platform. " + customerName + " by the way.", sentiment: "neutral" });
  t += randInt(6, 10);
  turns.push({ speaker: "agent", speakerName: agentName, ts: ts(t), text: pick(RECRUITER_LINES_EMPATHY), criterion: "Acknowledged candidate's situation early" });
  // middle turns
  const middleTurns = randInt(8, 16);
  for (let i = 0; i < middleTurns; i++) {
    t += randInt(8, 22);
    if (i % 2 === 0) {
      const isHesitant = chance(0.35);
      turns.push({ speaker: "customer", speakerName: customerName, ts: ts(t), text: isHesitant ? pick(CANDIDATE_LINES_FOLLOWUP) : "That sounds interesting. What's the team size and tech stack?", sentiment: isHesitant ? "negative" : "neutral", flag: isHesitant && chance(0.4) ? "Compensation/notice probe" : undefined });
    } else {
      turns.push({ speaker: "agent", speakerName: agentName, ts: ts(t), text: chance(0.5) ? "The CTC band is 28 to 34 LPA fixed, plus a 12 percent variable. The team is 18 engineers, full Java microservices stack on AWS." : "Notice period — they're flexible up to 60 days. If you can do buyout, that's even better. The role is hybrid, three days from the Bengaluru office.", criterion: i === middleTurns - 3 ? "Salary range discussed with rationale" : undefined });
    }
  }
  // wrap
  t = durationSec - randInt(15, 30);
  turns.push({ speaker: "agent", speakerName: agentName, ts: ts(t), text: "To recap: I'll send the JD on email, you'll review and confirm interest by tomorrow EOD, and I'll schedule the first round next week. Sound good?", criterion: "Closed with clear next steps & ETA" });
  t += randInt(4, 8);
  turns.push({ speaker: "customer", speakerName: customerName, ts: ts(t), text: chance(0.7) ? "Theek hai, let me look at it and get back. Thanks." : "Actually one more thing — can you share the client name on the JD itself?", sentiment: chance(0.7) ? "positive" : "neutral" });
  return turns;
}

function buildCriteriaResults(scorecard: Scorecard, turns: TranscriptTurn[]): { results: CriterionResult[]; score: number } {
  const results: CriterionResult[] = scorecard.criteria.map((c) => {
    const passed = chance(c.severity === "critical" ? 0.78 : c.severity === "high" ? 0.7 : 0.82);
    const score = passed ? randInt(c.passThreshold, 100) : randInt(30, c.passThreshold - 5);
    const evidenceTurns = turns.filter(t => t.criterion === c.name);
    const evidence = evidenceTurns.length ? evidenceTurns.slice(0, 2).map(t => ({ ts: t.ts, quote: t.text.slice(0, 140) + (t.text.length > 140 ? "…" : "") })) : [{ ts: turns[Math.min(2, turns.length - 1)].ts, quote: turns[Math.min(2, turns.length - 1)].text.slice(0, 120) + "…" }];
    const reasoning = passed
      ? `Criterion satisfied. Recruiter demonstrated the expected behaviour at ${evidence[0].ts}.`
      : c.category === "Empathy" ? `Candidate shared a constraint at ${evidence[0].ts}; recruiter moved to the next pitch point without acknowledging it.`
      : c.category === "Identification" ? `Recruiter pitched the demand without first confirming that the candidate's current scope and tech stack match. Pitch felt generic.`
      : c.category === "Compliance" ? `One or more mandatory disclosures (location lock-in, mandatory checks, garden leave) were not mentioned in the transcript.`
      : c.category === "Resolution" ? `Salary range stated as a number without rationale (band, equity, variable split). Rubric expects the rationale.`
      : c.category === "Escalation" ? `Notice period was mentioned but flexibility (buyout, partial release) was not probed. Likely a 90-day candidate at submission time.`
      : `Wrap-up missed at least one of: explicit next step, owner of next step, calendar date.`;
    return { criterionId: c.id, criterionName: c.name, weight: c.weight, score, passed, reasoning, evidence };
  });
  const totalWeight = results.reduce((s, r) => s + r.weight, 0);
  const score = Math.round(results.reduce((s, r) => s + r.score * r.weight, 0) / totalWeight);
  return { results, score };
}

function bandFor(score: number): "pass" | "warn" | "fail" {
  if (score >= 85) return "pass";
  if (score >= 70) return "warn";
  return "fail";
}

const TOPICS = ["JD walkthrough", "Compensation", "Notice period", "Location", "Tech stack", "Team structure", "Interview process", "Counter-offer", "Reference check", "Onboarding"];

export function buildConversations(count = 260): Conversation[] {
  const out: Conversation[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const agent = pick(AGENTS);
    const intent = pick(INTENTS);
    const isTechnical = intent.toLowerCase().includes("technical") || intent.toLowerCase().includes("java") || intent.toLowerCase().includes("python") || intent.toLowerCase().includes("react");
    const isCounter = intent.toLowerCase().includes("counter") || intent.toLowerCase().includes("ctc");
    const scorecard = isTechnical ? SCORECARDS[1] : isCounter ? SCORECARDS[2] : intent.toLowerCase().includes("compliance") ? SCORECARDS[3] : pick(SCORECARDS);
    const customerName = `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}`;
    const customerId = `CAND-${randInt(1000, 9999)}`;
    const durationSec = randInt(120, 1080);
    const date = new Date(now - randInt(0, 30 * 24 * 60 * 60 * 1000)).toISOString();
    const turns = buildTranscript(agent.name, customerName, durationSec);
    const { results, score } = buildCriteriaResults(scorecard, turns);
    const failed = results.filter(r => !r.passed);
    const issues = Array.from(new Set(failed.map(r => scorecard.criteria.find(c => c.id === r.criterionId)!.category))) as IssueCategory[];
    const sentiment: Sentiment = score >= 85 ? "positive" : score >= 70 ? "neutral" : chance(0.5) ? "negative" : "escalated";
    const outcome: Outcome = sentiment === "escalated" ? "Escalated" : score >= 75 ? "Resolved" : chance(0.4) ? "Follow-up required" : "Unresolved";
    const sentimentTimeline = Array.from({ length: 12 }, (_, k) => Math.round(50 + Math.sin(k / 2 + i) * 20 + (k * (score - 70) / 12)));
    out.push({
      id: `CV-${(10000 + i).toString()}`,
      date,
      agentId: agent.id,
      customerName, customerId,
      durationSec,
      intent,
      scorecardId: scorecard.id,
      score, band: bandFor(score),
      issues,
      sentiment,
      sentimentTrend: sentimentTimeline[sentimentTimeline.length - 1] > sentimentTimeline[0] ? "up" : sentimentTimeline[sentimentTimeline.length - 1] < sentimentTimeline[0] ? "down" : "flat",
      outcome,
      channel: "voice",
      summary: `Recruiter ${agent.name.split(" ")[0]} called candidate ${customerName} regarding ${intent.toLowerCase()}. ${score >= 80 ? "Pitch landed cleanly with appropriate empathy and disclosures." : score >= 70 ? "Reasonable pitch but missed at least one disclosure or rubric criterion." : "Struggled with positioning or compensation framing; candidate left noncommittal."}`,
      topics: pickN(TOPICS, randInt(2, 4)).map(name => ({ name, confidence: Math.round(rand(72, 98)) })),
      transcript: turns,
      criteria: results,
      compliance: [
        { item: "Confirmed identity & current role", ok: chance(0.92), ts: "00:08" },
        { item: "JD positioning clear", ok: chance(0.85), ts: "01:42" },
        { item: "Compensation range discussed", ok: chance(0.78), ts: "03:10" },
        { item: "Notice period validated", ok: chance(0.82), ts: "05:24" },
      ],
      sentimentTimeline,
      flagged: chance(0.12),
      reviewState: chance(0.3) ? (chance(0.7) ? "accepted" : "overridden") : "pending",
    });
  }
  // sort newest first
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

export const CONVERSATIONS = buildConversations(260);

// ---------- Coaching assignments ----------
export const COACHING: CoachingAssignment[] = (() => {
  const out: CoachingAssignment[] = [];
  for (let i = 0; i < 42; i++) {
    const agent = pick(AGENTS);
    const mod = pick(TRAINING);
    const dueOffset = randInt(-3, 7);
    const status = dueOffset < 0 ? (chance(0.4) ? "overdue" : "in_progress") : chance(0.25) ? "complete" : chance(0.4) ? "in_progress" : chance(0.5) ? "not_started" : "practice_required";
    const triggerCalls = pickN(CONVERSATIONS.filter(c => c.agentId === agent.id), Math.min(3, randInt(1, 4))).map(c => c.id);
    out.push({
      id: `CA-${1000 + i}`,
      agentId: agent.id,
      moduleId: mod.id,
      reason: `Failed "${mod.triggerCriterion}" on ${triggerCalls.length} calls in last 7 days`,
      triggerCallIds: triggerCalls,
      assignedAt: new Date(Date.now() - randInt(1, 14) * 86400000).toISOString(),
      dueAt: new Date(Date.now() + dueOffset * 86400000).toISOString(),
      status: status as CoachingAssignment["status"],
      completionScore: status === "complete" ? randInt(72, 98) : undefined,
      simulationScore: status === "complete" ? randInt(70, 96) : undefined,
    });
  }
  return out;
})();

// ---------- Voice screeners ----------
export const VOICE_AGENTS: VoiceAgent[] = [
  { id: "va-1", name: "General Screen — Hinglish", status: "active", purpose: "First-touch interest gauge for high-volume early-funnel calls", phone: "+91 80 4567 0142", callsToday: 312, resolutionRate: 78, avgHandleSec: 184, handoffRate: 22, lastDeployed: "2026-04-22", voice: "Aria (Hinglish, Female, Warm)", tone: "Calm, conversational",
    intents: [
      { name: "Confirm interest", description: "Confirm the candidate is actively looking and open to the role", success: "Candidate confirms interest and provides updated CTC", fallback: "Schedule recruiter callback" },
      { name: "Capture CTC + notice", description: "Capture current CTC, expected CTC, and notice period", success: "All three captured and stored on the prospect", fallback: "Mark prospect as 'unreachable'" },
      { name: "Location alignment", description: "Validate location preference vs demand requirement", success: "Candidate confirms location works", fallback: "Surface mismatch reason and queue for recruiter" },
    ] },
  { id: "va-2", name: "Technical Screen — Java", status: "active", purpose: "8-12 minute technical screen for senior Java backend roles", phone: "+91 80 4567 0188", callsToday: 421, resolutionRate: 91, avgHandleSec: 96, handoffRate: 9, lastDeployed: "2026-04-18", voice: "Liam (Indian English, Male, Neutral)", tone: "Professional, probing",
    intents: [
      { name: "Probe Java fundamentals", description: "Three-question probe on JVM, concurrency, GC", success: "Depth captured and graded", fallback: "Hand off to recruiter on borderline" },
      { name: "System design check", description: "Single open-ended design question", success: "Design notes captured", fallback: "Hand off if structurally weak" },
    ] },
  { id: "va-3", name: "Interest Gauge — Re-engagement", status: "active", purpose: "Re-engages candidates from the talent pool who were last spoken to 30+ days ago", phone: "+91 80 4567 0156", callsToday: 187, resolutionRate: 84, avgHandleSec: 162, handoffRate: 16, lastDeployed: "2026-04-12", voice: "Sofia (Hinglish, Female, Soft)", tone: "Warm, brief",
    intents: [
      { name: "Confirm still active", description: "Check if the candidate is still job-hunting", success: "Candidate reconfirms interest", fallback: "Mark as 'parked'" },
      { name: "Capture updated profile", description: "Capture any updated CTC / role / company", success: "Profile updates flow back to candidates row", fallback: "Surface to recruiter" },
    ] },
  { id: "va-4", name: "Notice Period & Comp Check", status: "active", purpose: "Narrow scope — confirms NP and CTC alignment for a specific demand before recruiter outreach", phone: "+91 80 4567 0173", callsToday: 268, resolutionRate: 88, avgHandleSec: 142, handoffRate: 12, lastDeployed: "2026-04-05", voice: "Ethan (Indian English, Male, Clear)", tone: "Direct, respectful",
    intents: [
      { name: "Confirm CTC fit", description: "State demand band and capture candidate expectation", success: "Mark prospect as compensation_aligned", fallback: "Mark as compensation_gap" },
      { name: "Confirm notice fit", description: "State demand notice expectation and capture candidate's", success: "Mark notice_fit", fallback: "Mark notice_gap" },
    ] },
];

// ---------- Knowledge base ----------
export const KB: KBSource[] = [
  { id: "kb-1", name: "JD Library — Active Demands", type: "Confluence", status: "indexed", documents: 142, lastUpdated: "2026-04-26", retrievals7d: 2841 },
  { id: "kb-2", name: "Client Profiles — Strategic GCC", type: "SharePoint", status: "indexed", documents: 318, lastUpdated: "2026-04-24", retrievals7d: 4112 },
  { id: "kb-3", name: "Recruiter Playbooks (Hinglish)", type: "Upload", status: "indexed", documents: 47, lastUpdated: "2026-04-18", retrievals7d: 1209 },
  { id: "kb-4", name: "Compensation Benchmarks — India 2026", type: "Upload", status: "indexed", documents: 612, lastUpdated: "2026-04-27", retrievals7d: 3221 },
  { id: "kb-5", name: "Interview Coordination SOPs", type: "Upload", status: "indexed", documents: 28, lastUpdated: "2026-04-09", retrievals7d: 482 },
  { id: "kb-6", name: "Q2 2026 Demands — Pricing Update", type: "Upload", status: "indexing", documents: 14, lastUpdated: "2026-04-28", retrievals7d: 0 },
];

// ---------- Users ----------
export const USERS: User[] = [
  ...AGENTS.map(a => ({ id: a.id, name: a.name, email: a.email, role: a.role, team: TEAMS.find(t => t.id === a.teamId)!.name, status: "active" as const, lastActive: new Date(Date.now() - randInt(0, 60) * 60000).toISOString() })),
  { id: "u-100", name: "Daniel Dsouza", email: "daniel.dsouza@recruitassist.local", role: "Admin", team: "Strategic GCC Cell", status: "active", lastActive: new Date().toISOString() },
  { id: "u-101", name: "Jordan Park", email: "jordan.park@recruitassist.local", role: "QA Reviewer", team: "Quality", status: "active", lastActive: new Date(Date.now() - 12 * 60000).toISOString() },
  { id: "u-102", name: "Morgan Lee", email: "morgan.lee@recruitassist.local", role: "QA Reviewer", team: "Quality", status: "active", lastActive: new Date(Date.now() - 41 * 60000).toISOString() },
  { id: "u-103", name: "Sam Rivera", email: "sam.rivera@recruitassist.local", role: "Manager", team: "Operations", status: "invited", lastActive: "" },
];

// ---------- Activity ----------
export const ACTIVITY: ActivityEvent[] = [
  { id: "ev-1", ts: new Date(Date.now() - 4 * 60000).toISOString(), actor: "Jordan Park", text: "overrode AI rubric on CV-10231 (Salary Handling criterion)", type: "review" },
  { id: "ev-2", ts: new Date(Date.now() - 17 * 60000).toISOString(), actor: "System", text: "assigned 'Notice period objection handling' to Karan Singh", type: "coaching" },
  { id: "ev-3", ts: new Date(Date.now() - 32 * 60000).toISOString(), actor: "Daniel Dsouza", text: "edited rubric 'Technical Screen' (added 'Asked at least 3 technical probing questions' criterion)", type: "scorecard" },
  { id: "ev-4", ts: new Date(Date.now() - 58 * 60000).toISOString(), actor: "System", text: "deployed voice screener 'General Screen — Hinglish' v3.2", type: "voice" },
  { id: "ev-5", ts: new Date(Date.now() - 92 * 60000).toISOString(), actor: "Sam Rivera", text: "completed 'Compensation conversation framing' (score 92)", type: "coaching" },
  { id: "ev-6", ts: new Date(Date.now() - 138 * 60000).toISOString(), actor: "Daniel Dsouza", text: "invited 4 new recruiters to the workspace", type: "user" },
  { id: "ev-7", ts: new Date(Date.now() - 184 * 60000).toISOString(), actor: "Morgan Lee", text: "accepted AI rubric on 14 calls in QA queue", type: "review" },
  { id: "ev-8", ts: new Date(Date.now() - 240 * 60000).toISOString(), actor: "System", text: "voice screener 'Technical Screen — Java' completion rate dropped 4% week-over-week", type: "voice" },
];

export const NOTIFICATIONS: Notification[] = [
  { id: "n-1", ts: new Date(Date.now() - 7 * 60000).toISOString(), title: "3 calls failed Salary Handling rubric", body: "Priya Sharma — review recommended", read: false, type: "alert" },
  { id: "n-2", ts: new Date(Date.now() - 22 * 60000).toISOString(), title: "Coaching overdue", body: "Karan Singh — Notice period objection handling (2 days overdue)", read: false, type: "alert" },
  { id: "n-3", ts: new Date(Date.now() - 64 * 60000).toISOString(), title: "Voice screener performance dropped", body: "General Screen — Hinglish — qualification rate -8% this week", read: false, type: "alert" },
  { id: "n-4", ts: new Date(Date.now() - 124 * 60000).toISOString(), title: "Weekly QA report ready", body: "Quality summary for week of Apr 20 is available", read: true, type: "info" },
  { id: "n-5", ts: new Date(Date.now() - 320 * 60000).toISOString(), title: "Sam Rivera completed coaching", body: "Score: 92 — passed first attempt", read: true, type: "success" },
];

// ============================================================================
// New mock arrays added for Phase 1 demo readiness
// ============================================================================

// ---------- Assessments ----------
export interface AssessmentTemplate {
  id: string;
  name: string;
  skill: string;
  level: "junior" | "mid" | "senior" | "staff";
  durationMin: number;
  questionCount: number;
  attempts: number;
  avgScore: number;
  passRate: number; // 0..1
  status: "active" | "draft" | "archived";
  lastUpdated: string;
}
export interface AssessmentAttempt {
  id: string;
  templateId: string;
  candidateName: string;
  candidateId: string;
  demandTitle: string;
  invitedAt: string;
  startedAt?: string;
  submittedAt?: string;
  score?: number;
  passed?: boolean;
  status: "invited" | "in_progress" | "submitted" | "expired";
}

export const ASSESSMENTS: AssessmentTemplate[] = [
  { id: "as-1", name: "Java Backend — Senior", skill: "Java", level: "senior", durationMin: 60, questionCount: 18, attempts: 142, avgScore: 71, passRate: 0.58, status: "active", lastUpdated: "2026-04-20" },
  { id: "as-2", name: "React Frontend — Mid", skill: "React", level: "mid", durationMin: 45, questionCount: 14, attempts: 96, avgScore: 76, passRate: 0.66, status: "active", lastUpdated: "2026-04-18" },
  { id: "as-3", name: "SQL Fundamentals", skill: "SQL", level: "mid", durationMin: 30, questionCount: 10, attempts: 218, avgScore: 82, passRate: 0.74, status: "active", lastUpdated: "2026-04-12" },
  { id: "as-4", name: "System Design — Staff", skill: "System Design", level: "staff", durationMin: 90, questionCount: 4, attempts: 51, avgScore: 64, passRate: 0.41, status: "active", lastUpdated: "2026-04-09" },
  { id: "as-5", name: "Python Data Engineering", skill: "Python", level: "mid", durationMin: 50, questionCount: 12, attempts: 87, avgScore: 73, passRate: 0.61, status: "active", lastUpdated: "2026-04-04" },
  { id: "as-6", name: "DevOps / AWS Practitioner", skill: "AWS", level: "mid", durationMin: 40, questionCount: 16, attempts: 64, avgScore: 69, passRate: 0.55, status: "draft", lastUpdated: "2026-04-26" },
];

export const ASSESSMENT_ATTEMPTS: AssessmentAttempt[] = (() => {
  const out: AssessmentAttempt[] = [];
  for (let i = 0; i < 32; i++) {
    const tpl = pick(ASSESSMENTS);
    const candidate = `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}`;
    const status = chance(0.55) ? "submitted" : chance(0.4) ? "in_progress" : chance(0.5) ? "invited" : "expired";
    const invited = new Date(Date.now() - randInt(1, 14) * 86400000).toISOString();
    const submitted = status === "submitted" ? new Date(Date.now() - randInt(0, 6) * 86400000).toISOString() : undefined;
    const score = status === "submitted" ? randInt(35, 95) : undefined;
    out.push({
      id: `ATT-${1000 + i}`,
      templateId: tpl.id,
      candidateName: candidate,
      candidateId: `CAND-${randInt(1000, 9999)}`,
      demandTitle: pick(["Senior Java Backend", "React UI Lead", "Data Engineer", "Staff Engineer", "Python ML"]),
      invitedAt: invited,
      startedAt: status !== "invited" ? invited : undefined,
      submittedAt: submitted,
      score,
      passed: typeof score === "number" ? score >= 70 : undefined,
      status,
    });
  }
  return out;
})();

// ---------- Async Video ----------
export interface AsyncVideoCampaign {
  id: string;
  name: string;
  demandTitle: string;
  questions: number;
  invited: number;
  completed: number;
  avgScore: number;
  status: "active" | "paused" | "complete";
  createdAt: string;
}
export interface AsyncVideoSubmission {
  id: string;
  campaignId: string;
  candidateName: string;
  candidateId: string;
  durationSec: number;
  submittedAt: string;
  aiScore: number;
  reviewerScore?: number;
  status: "pending_review" | "approved" | "rejected";
}

export const ASYNC_VIDEO_CAMPAIGNS: AsyncVideoCampaign[] = [
  { id: "av-1", name: "Senior Java — Behavioural", demandTitle: "Senior Java Backend (Strategic GCC)", questions: 4, invited: 38, completed: 24, avgScore: 74, status: "active", createdAt: "2026-04-15" },
  { id: "av-2", name: "Frontend Intro — React", demandTitle: "React UI Lead (Premium Accounts)", questions: 3, invited: 22, completed: 19, avgScore: 81, status: "active", createdAt: "2026-04-18" },
  { id: "av-3", name: "Data Eng — Hinglish", demandTitle: "Senior Data Engineer", questions: 5, invited: 14, completed: 14, avgScore: 79, status: "complete", createdAt: "2026-04-02" },
  { id: "av-4", name: "Cultural Fit — GCC #1", demandTitle: "Multiple roles", questions: 3, invited: 56, completed: 41, avgScore: 76, status: "active", createdAt: "2026-04-10" },
];

export const ASYNC_VIDEO_SUBMISSIONS: AsyncVideoSubmission[] = (() => {
  const out: AsyncVideoSubmission[] = [];
  for (let i = 0; i < 24; i++) {
    const c = pick(ASYNC_VIDEO_CAMPAIGNS);
    out.push({
      id: `AVS-${2000 + i}`,
      campaignId: c.id,
      candidateName: `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}`,
      candidateId: `CAND-${randInt(1000, 9999)}`,
      durationSec: randInt(220, 720),
      submittedAt: new Date(Date.now() - randInt(0, 7) * 86400000).toISOString(),
      aiScore: randInt(45, 95),
      reviewerScore: chance(0.4) ? randInt(40, 95) : undefined,
      status: chance(0.5) ? "pending_review" : chance(0.6) ? "approved" : "rejected",
    });
  }
  return out;
})();

// ---------- Proctor Cockpit ----------
export interface ProctorSession {
  id: string;
  candidateName: string;
  candidateInitials: string;
  demandTitle: string;
  assessmentName: string;
  startedAt: string;
  progressPct: number;
  flagCount: number;
  integrityScore: number; // 0..100
  status: "live" | "review" | "complete";
}
export interface ProctorFlag {
  id: string;
  sessionId: string;
  ts: string; // ISO
  severity: "low" | "medium" | "high";
  type: "face_lost" | "second_face" | "tab_switch" | "audio_anomaly" | "phone_detected";
  description: string;
}

export const PROCTOR_SESSIONS: ProctorSession[] = (() => {
  const out: ProctorSession[] = [];
  const personas = pickN(FIRST_NAMES, 8);
  const demands = ["Senior Java Backend", "React UI Lead", "Data Engineer", "Staff Engineer", "Python ML", "DevOps Lead", "QA Automation", "Senior Frontend"];
  for (let i = 0; i < 8; i++) {
    const flags = randInt(0, 4);
    out.push({
      id: `PS-${100 + i}`,
      candidateName: `${personas[i]} ${pick(LAST_INITIALS)}`,
      candidateInitials: personas[i].slice(0, 2).toUpperCase(),
      demandTitle: demands[i],
      assessmentName: pick(ASSESSMENTS).name,
      startedAt: new Date(Date.now() - randInt(5, 80) * 60000).toISOString(),
      progressPct: randInt(15, 95),
      flagCount: flags,
      integrityScore: 100 - flags * randInt(8, 15),
      status: i < 6 ? "live" : "review",
    });
  }
  return out;
})();

export const PROCTOR_FLAGS: ProctorFlag[] = (() => {
  const out: ProctorFlag[] = [];
  const types: ProctorFlag["type"][] = ["face_lost", "second_face", "tab_switch", "audio_anomaly", "phone_detected"];
  const desc: Record<ProctorFlag["type"], string> = {
    face_lost: "Face left frame for >4 seconds",
    second_face: "Second face detected in frame",
    tab_switch: "Browser tab switched",
    audio_anomaly: "Background voice detected",
    phone_detected: "Mobile phone visible in frame",
  };
  for (let i = 0; i < 18; i++) {
    const session = pick(PROCTOR_SESSIONS);
    const type = pick(types);
    out.push({
      id: `FLG-${500 + i}`,
      sessionId: session.id,
      ts: new Date(Date.now() - randInt(1, 60) * 60000).toISOString(),
      severity: type === "second_face" || type === "phone_detected" ? "high" : type === "tab_switch" ? "medium" : "low",
      type,
      description: desc[type],
    });
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
})();

// ---------- Client Portal ----------
export interface ClientPortalDemand {
  id: string;
  title: string;
  openings: number;
  submitted: number;
  awaitingFeedback: number;
  inInterview: number;
  offered: number;
}
export interface ClientPortalSubmission {
  id: string;
  demandId: string;
  demandTitle: string;
  candidateName: string;
  candidateInitials: string;
  experienceYears: number;
  currentCompany: string;
  expectedCtcLakhs: number;
  noticeDays: number;
  submittedAt: string;
  stage: "client_screen" | "l1_scheduled" | "l2_scheduled" | "l3_scheduled" | "final_select" | "offer_pending";
}

export const CLIENT_PORTAL_DEMANDS: ClientPortalDemand[] = [
  { id: "cd-1", title: "Senior Java Backend Engineer", openings: 4, submitted: 12, awaitingFeedback: 3, inInterview: 6, offered: 1 },
  { id: "cd-2", title: "React UI Lead", openings: 2, submitted: 8, awaitingFeedback: 2, inInterview: 4, offered: 0 },
  { id: "cd-3", title: "Senior Data Engineer", openings: 3, submitted: 10, awaitingFeedback: 4, inInterview: 3, offered: 2 },
  { id: "cd-4", title: "Staff Engineer — Platform", openings: 1, submitted: 5, awaitingFeedback: 1, inInterview: 2, offered: 1 },
];

export const CLIENT_PORTAL_SUBMISSIONS: ClientPortalSubmission[] = (() => {
  const out: ClientPortalSubmission[] = [];
  for (let i = 0; i < 18; i++) {
    const d = pick(CLIENT_PORTAL_DEMANDS);
    const candidate = `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}`;
    out.push({
      id: `SUB-${3000 + i}`,
      demandId: d.id,
      demandTitle: d.title,
      candidateName: candidate,
      candidateInitials: candidate.split(" ").map(p => p[0]).slice(0, 2).join(""),
      experienceYears: randInt(3, 14),
      currentCompany: pick(["Infosys", "TCS", "Wipro", "HCL", "Accenture", "Cognizant", "Mindtree", "Persistent", "Razorpay", "Flipkart"]),
      expectedCtcLakhs: randInt(18, 48),
      noticeDays: pick([30, 45, 60, 90]),
      submittedAt: new Date(Date.now() - randInt(0, 10) * 86400000).toISOString(),
      stage: pick(["client_screen", "l1_scheduled", "l2_scheduled", "l3_scheduled", "final_select", "offer_pending"]) as ClientPortalSubmission["stage"],
    });
  }
  return out;
})();

// ---------- Sourcing (mock external results) ----------
export interface SourcingResult {
  id: string;
  name: string;
  initials: string;
  currentTitle: string;
  currentCompany: string;
  experienceYears: number;
  location: string;
  skills: string[];
  expectedCtcLakhs: number;
  noticeDays: number;
  lastActive: string;
}

function makeSourcingPool(n: number, seedTag: string): SourcingResult[] {
  const titles = ["Senior Software Engineer", "SDE 2", "Lead Engineer", "Engineering Manager", "Staff Engineer", "Principal Engineer", "Senior Backend Developer", "Senior Frontend Developer"];
  const companies = ["Infosys", "TCS", "Wipro", "Accenture", "Cognizant", "Razorpay", "Flipkart", "Swiggy", "PhonePe", "Walmart Labs", "Microsoft IDC", "Amazon", "Goldman Sachs", "Morgan Stanley"];
  const cities = ["Bengaluru, IN", "Hyderabad, IN", "Pune, IN", "Mumbai, IN", "Gurugram, IN", "Chennai, IN", "Noida, IN"];
  const skillSets = [["Java", "Spring Boot", "AWS", "Kafka"], ["React", "TypeScript", "Next.js", "GraphQL"], ["Python", "FastAPI", "PyTorch", "AWS"], ["Java", "Microservices", "Kubernetes", "AWS"], ["Go", "gRPC", "PostgreSQL", "AWS"], ["React", "React Native", "Redux", "Node"]];
  const out: SourcingResult[] = [];
  for (let i = 0; i < n; i++) {
    const candidate = `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}`;
    out.push({
      id: `${seedTag}-${1000 + i}`,
      name: candidate,
      initials: candidate.split(" ").map(p => p[0]).slice(0, 2).join(""),
      currentTitle: pick(titles),
      currentCompany: pick(companies),
      experienceYears: randInt(3, 16),
      location: pick(cities),
      skills: pick(skillSets),
      expectedCtcLakhs: randInt(18, 52),
      noticeDays: pick([30, 45, 60, 90]),
      lastActive: new Date(Date.now() - randInt(0, 30) * 86400000).toISOString(),
    });
  }
  return out;
}

export const SOURCING_NAUKRI: SourcingResult[] = makeSourcingPool(10, "NK");
export const SOURCING_LINKEDIN: SourcingResult[] = makeSourcingPool(10, "LI");

// ---------- Helpers ----------
export function getAgent(id: string) {
  return AGENTS.find(a => a.id === id) || CURRENT_USER;
}
export function getTeam(id: string) {
  return TEAMS.find(t => t.id === id);
}
export function getScorecard(id: string) {
  return SCORECARDS.find(s => s.id === id);
}
export function getModule(id: string) {
  return TRAINING.find(m => m.id === id);
}
export function getConversation(id: string) {
  return CONVERSATIONS.find(c => c.id === id);
}
export function getAssessment(id: string) {
  return ASSESSMENTS.find(a => a.id === id);
}
export function getAsyncVideoCampaign(id: string) {
  return ASYNC_VIDEO_CAMPAIGNS.find(c => c.id === id);
}
export function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
export function formatRelative(iso: string) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
export function formatDateTime(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
