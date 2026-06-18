// Standard contact-center QA parameters, adapted for J2W (solar/energy, Hinglish).
// Based on COPC / Deloitte contact-center rubrics.

export type QAParameterGroup =
  | "opening"
  | "diagnosis"
  | "resolution"
  | "compliance"
  | "communication"
  | "closing"
  | "efficiency";

export type QAParameterKind = "checklist" | "metric";

export interface QAParameter {
  id: string;
  group: QAParameterGroup;
  label: string;
  description: string;
  kind: QAParameterKind;
  /** If this parameter overlaps an existing scorecard criterion (by criterion name), link to it instead of duplicating the score. */
  mapsToCriterionName?: string;
  /** True if this parameter can only be evaluated from audio (acoustic features). Phase 2 only. */
  requiresAudio?: boolean;
  /** For metrics: rough target band; for display only. */
  target?: string;
}

export const QA_PARAMETER_GROUPS: { id: QAParameterGroup; label: string }[] = [
  { id: "opening", label: "Opening" },
  { id: "diagnosis", label: "Diagnosis" },
  { id: "resolution", label: "Resolution" },
  { id: "compliance", label: "Compliance" },
  { id: "communication", label: "Communication" },
  { id: "closing", label: "Closing" },
  { id: "efficiency", label: "Efficiency metrics" },
];

export const QA_PARAMETERS: QAParameter[] = [
  {
    id: "greeting-brand",
    group: "opening",
    label: "Greeting & brand identification",
    description: "Agent opens with a standard greeting and names the company (Joules to Watts).",
    kind: "checklist",
  },
  {
    id: "agent-self-id",
    group: "opening",
    label: "Agent self-identification",
    description: "Agent clearly states their own name in the opening.",
    kind: "checklist",
  },
  {
    id: "customer-verification",
    group: "opening",
    label: "Customer identity verification (KYC)",
    description: "Verified customer identity using required methods before discussing the account.",
    kind: "checklist",
    mapsToCriterionName: "Verified customer identity",
  },
  {
    id: "active-listening",
    group: "communication",
    label: "Active listening / no interruptions",
    description: "Agent does not interrupt the customer; paraphrases back understanding.",
    kind: "metric",
    target: "0 interruptions",
  },
  {
    id: "empathy",
    group: "communication",
    label: "Empathy & rapport",
    description: "Agent acknowledges emotion before moving to facts when the customer is frustrated.",
    kind: "checklist",
    mapsToCriterionName: "Acknowledged frustration within 30s",
  },
  {
    id: "problem-diagnosis",
    group: "diagnosis",
    label: "Accurate problem diagnosis",
    description: "Agent asks enough discovery questions to identify the root cause, not just the surface symptom.",
    kind: "checklist",
    mapsToCriterionName: "Correct problem identification",
  },
  {
    id: "kb-resolution-accuracy",
    group: "resolution",
    label: "Solution accuracy vs SOP/KB",
    description: "The resolution the agent provided matches the canonical answer in the knowledge base.",
    kind: "checklist",
  },
  {
    id: "fcr",
    group: "resolution",
    label: "First-Call Resolution (FCR)",
    description: "Call was resolved without requiring the customer to call back within 14 days.",
    kind: "metric",
  },
  {
    id: "hold-transfer",
    group: "communication",
    label: "Hold & transfer etiquette",
    description: "Agent asked permission before placing on hold; provided reason; warm-transferred if handed off.",
    kind: "checklist",
  },
  {
    id: "compliance-disclosures",
    group: "compliance",
    label: "Compliance & regulatory disclosures",
    description: "All required disclosures for this call type were delivered (recording, fees, privacy).",
    kind: "checklist",
    mapsToCriterionName: "Required disclosures completed",
  },
  {
    id: "script-adherence",
    group: "resolution",
    label: "Script / process adherence",
    description: "Agent followed the prescribed process for this intent.",
    kind: "metric",
  },
  {
    id: "dead-air",
    group: "efficiency",
    label: "Dead-air management",
    description: "Gaps between consecutive speaker turns over 3 seconds.",
    kind: "metric",
    target: "< 15s total",
  },
  {
    id: "pacing-wpm",
    group: "efficiency",
    label: "Pacing (words per minute)",
    description: "Agent speaking rate.",
    kind: "metric",
    target: "130–160 WPM",
  },
  {
    id: "language-code-switching",
    group: "communication",
    label: "Language appropriateness (Hinglish)",
    description: "Agent's Hindi/English code-switching matches the customer's register (language match, not forced).",
    kind: "checklist",
  },
  {
    id: "domain-knowledge",
    group: "resolution",
    label: "Product/domain knowledge (solar)",
    description: "Agent demonstrated accurate knowledge of J2W solar products, subsidies, net-metering, warranty.",
    kind: "checklist",
  },
  {
    id: "professionalism",
    group: "communication",
    label: "Professionalism & courtesy",
    description: "No argumentative, disrespectful, or prohibited phrases used.",
    kind: "checklist",
  },
  {
    id: "closing-recap",
    group: "closing",
    label: "Closing — recap, next steps, thank you",
    description: "Agent summarized resolution, confirmed next steps, offered additional help, and thanked the customer.",
    kind: "checklist",
    mapsToCriterionName: "Followed call wrap process",
  },
  {
    id: "aht",
    group: "efficiency",
    label: "Average Handle Time (AHT)",
    description: "Total call duration.",
    kind: "metric",
  },
  {
    id: "talk-listen-ratio",
    group: "efficiency",
    label: "Talk:listen ratio",
    description: "Share of speaking time by agent vs customer.",
    kind: "metric",
    target: "40–60% agent",
  },
  {
    id: "sentiment-arc",
    group: "resolution",
    label: "Sentiment arc (start → end)",
    description: "Change in customer sentiment from first third to last third of the call.",
    kind: "metric",
    target: "Recovery or stable",
  },
];
