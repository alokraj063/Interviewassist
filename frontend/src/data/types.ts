export type IssueCategory = "Identification" | "Resolution" | "Escalation" | "Compliance" | "Empathy" | "Process";
export type Sentiment = "positive" | "neutral" | "negative" | "escalated";
export type Outcome = "Resolved" | "Escalated" | "Follow-up required" | "Unresolved";
export type ScoreBand = "pass" | "warn" | "fail";

export interface Team { id: string; name: string; managerId: string; }
export interface Agent {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: "Agent" | "Team Lead" | "Manager" | "QA Reviewer" | "Admin";
  teamId: string;
  tenureMonths: number;
  region: string;
  avgScore: number;
  callsHandled7d: number;
  callsHandled30d: number;
  weaknesses: IssueCategory[];
  openCoaching: number;
  trend: number; // -10..+10
  scoreSpark: number[]; // 14 days
  status: "active" | "in_call" | "away" | "offline";
}

export interface ScorecardCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  passThreshold: number;
  severity: "low" | "medium" | "high" | "critical";
  category: IssueCategory;
  trainingModuleId?: string;
}
export interface Scorecard {
  id: string;
  name: string;
  description: string;
  appliesTo: string;
  active: boolean;
  criteria: ScorecardCriterion[];
  modified: string;
  timesUsed: number;
}

export interface TrainingModule {
  id: string;
  title: string;
  description: string;
  triggerCriterion: string;
  duration: number; // min
  timesAssigned: number;
  completionRate: number;
  postImprovement: number; // %
  severity: "low" | "medium" | "high" | "critical";
  category: IssueCategory;
  simulationId?: string;
}

export interface CoachingAssignment {
  id: string;
  agentId: string;
  moduleId: string;
  reason: string;
  triggerCallIds: string[];
  assignedAt: string;
  dueAt: string;
  status: "not_started" | "in_progress" | "practice_required" | "complete" | "overdue";
  completionScore?: number;
  simulationScore?: number;
}

export interface TranscriptTurn {
  speaker: "agent" | "customer";
  speakerName: string;
  ts: string; // mm:ss
  text: string;
  sentiment?: Sentiment;
  criterion?: string;
  flag?: string;
}

export interface CriterionResult {
  criterionId: string;
  criterionName: string;
  weight: number;
  score: number;
  passed: boolean;
  reasoning: string;
  evidence: { ts: string; quote: string }[];
}

export interface Conversation {
  id: string;
  date: string; // ISO
  agentId: string;
  customerName: string;
  customerId: string;
  durationSec: number;
  intent: string;
  scorecardId: string;
  score: number;
  band: ScoreBand;
  issues: IssueCategory[];
  sentiment: Sentiment;
  sentimentTrend: "up" | "down" | "flat";
  outcome: Outcome;
  channel: "voice" | "chat";
  summary: string;
  topics: { name: string; confidence: number }[];
  transcript: TranscriptTurn[];
  criteria: CriterionResult[];
  compliance: { item: string; ok: boolean; ts?: string }[];
  sentimentTimeline: number[];
  flagged?: boolean;
  reviewState?: "pending" | "accepted" | "overridden";
}

export interface VoiceAgent {
  id: string;
  name: string;
  status: "active" | "paused";
  purpose: string;
  phone: string;
  callsToday: number;
  resolutionRate: number;
  avgHandleSec: number;
  handoffRate: number;
  lastDeployed: string;
  voice: string;
  tone: string;
  intents: { name: string; description: string; success: string; fallback: string }[];
}

export interface KBSource {
  id: string;
  name: string;
  type: "URL" | "Upload" | "Confluence" | "SharePoint";
  status: "indexed" | "indexing" | "error";
  documents: number;
  lastUpdated: string;
  retrievals7d: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  team: string;
  status: "active" | "invited" | "suspended";
  lastActive: string;
}

export interface ActivityEvent {
  id: string;
  ts: string;
  actor: string;
  text: string;
  type: "coaching" | "scorecard" | "voice" | "user" | "review";
}

export interface Notification {
  id: string;
  ts: string;
  title: string;
  body: string;
  read: boolean;
  type: "alert" | "info" | "success";
}
