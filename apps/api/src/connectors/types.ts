// Pluggable candidate-sourcing connector interface. Implementations:
//   - mock.ts (deterministic fake data so flows work without real keys)
//   - naukri.ts, linkedin.ts, etc. (added later as separate tasks)
//
// All consumers go through registry.getConnector(orgId, providerKey) so the
// resolver can pick the real or mock variant based on tenant_integrations
// state.

export interface CandidatePreview {
  externalId: string;
  source: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  totalExperienceYears: number | null;
  expectedCtcLakhs: number | null;
  noticePeriodDays: number | null;
  currentLocation: string | null;
  skills: string[];
  rawProfileUrl: string | null;
  fetchedAt: string;
}

export interface PullCandidatesQuery {
  q?: string;
  skill?: string;
  location?: string;
  minExperienceYears?: number;
  maxExperienceYears?: number;
  limit?: number;
}

export interface PushPlacementInput {
  externalCandidateId: string;
  demandTitle: string;
  clientName: string;
  status: "submitted" | "interviewing" | "offered" | "hired" | "rejected";
  ctaUrl?: string;
}

export interface ConnectorHealth {
  ok: boolean;
  reason?: string;
}

export interface Connector {
  readonly key: string;
  readonly displayName: string;
  health(): Promise<ConnectorHealth>;
  pullCandidates(q: PullCandidatesQuery): Promise<CandidatePreview[]>;
  pushPlacement?(p: PushPlacementInput): Promise<{ ok: boolean; remoteId?: string }>;
}
