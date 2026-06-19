// Cumulative session risk-score computation for the proctor cockpit.
//
// riskScore = clamp(0, 100, Σ over flagged events of weight(kind) × severityMult)
// where severityMult = { low:1, medium:2, high:3 } and weight comes from the
// session's policy snapshot signalConfig[kind].weight (falling back to a
// default-weight table when the policy didn't arm a given kind).
//
// Shared by:
//   - the events-ingest route (recompute on each new event, auto-flag/auto-
//     terminate when thresholds cross),
//   - the demo seed (so seeded RiskMeters + risk-sort reflect real events).
import {
  PROCTOR_SIGNAL_SEVERITIES,
  type ProctorSignalConfig,
  type ProctorSignalSeverity,
} from "@j2w/db";

export const SEVERITY_MULTIPLIER: Record<ProctorSignalSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

// Default per-kind weight when a policy didn't arm the signal. Higher = more
// damning. Identity-capture markers carry zero weight (they're not violations).
export const DEFAULT_SIGNAL_WEIGHTS: Record<string, number> = {
  tab_switch: 6,
  window_blur: 5,
  fullscreen_exit: 8,
  copy: 7,
  paste: 9,
  multi_face: 20,
  no_face: 10,
  face_mismatch: 25,
  other_voice: 12,
  second_device: 18,
  network_drop: 3,
  vm_detected: 22,
  remote_tool: 24,
  screen_share_lost: 8,
  id_photo_captured: 0,
  env_scan_captured: 0,
};

// Default per-kind severity, used when a policy didn't set one for the kind.
export const DEFAULT_SIGNAL_SEVERITY: Record<string, ProctorSignalSeverity> = {
  tab_switch: "low",
  window_blur: "low",
  fullscreen_exit: "medium",
  copy: "medium",
  paste: "high",
  multi_face: "high",
  no_face: "medium",
  face_mismatch: "high",
  other_voice: "medium",
  second_device: "high",
  network_drop: "low",
  vm_detected: "high",
  remote_tool: "high",
  screen_share_lost: "medium",
  id_photo_captured: "low",
  env_scan_captured: "low",
};

export interface RiskEventLike {
  kind: string;
  severity: ProctorSignalSeverity;
  flagged: boolean;
}

function isSeverity(v: unknown): v is ProctorSignalSeverity {
  return typeof v === "string" && (PROCTOR_SIGNAL_SEVERITIES as readonly string[]).includes(v);
}

/** Weight + effective severity for a kind under a (possibly partial) policy. */
export function signalWeights(
  kind: string,
  signalConfig: ProctorSignalConfig | null | undefined,
): { weight: number; severity: ProctorSignalSeverity; armed: boolean } {
  const cfg = signalConfig?.[kind];
  if (cfg) {
    return {
      weight: typeof cfg.weight === "number" ? cfg.weight : DEFAULT_SIGNAL_WEIGHTS[kind] ?? 5,
      severity: isSeverity(cfg.severity) ? cfg.severity : DEFAULT_SIGNAL_SEVERITY[kind] ?? "low",
      armed: cfg.armed !== false,
    };
  }
  return {
    weight: DEFAULT_SIGNAL_WEIGHTS[kind] ?? 5,
    severity: DEFAULT_SIGNAL_SEVERITY[kind] ?? "low",
    armed: true,
  };
}

/** Compute the cumulative 0-100 risk score for a set of events under a policy. */
export function computeRiskScore(
  events: RiskEventLike[],
  signalConfig: ProctorSignalConfig | null | undefined,
): number {
  let total = 0;
  for (const ev of events) {
    if (!ev.flagged) continue;
    const { weight, severity, armed } = signalWeights(ev.kind, signalConfig);
    if (!armed) continue;
    const sev = isSeverity(ev.severity) ? ev.severity : severity;
    total += weight * SEVERITY_MULTIPLIER[sev];
  }
  return Math.max(0, Math.min(100, Math.round(total)));
}

export type RiskLabel = "low" | "elevated" | "high";

/** Text label for a11y + filtering. */
export function riskLabel(score: number): RiskLabel {
  if (score >= 70) return "high";
  if (score >= 35) return "elevated";
  return "low";
}
