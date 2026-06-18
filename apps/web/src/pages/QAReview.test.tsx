// QA Review console — component tests (Vitest + jsdom).
//
// Covers the queue list states (loading skeleton / first-run-empty distinct from
// filtered-to-zero / error with inline server message + Retry / permission-gated
// read access), the enabled-CTA regression (Create policy enabled WITH
// qa.sampling, disabled WITHOUT — no "coming soon" toast), and the
// SamplingPolicyDialog disabled-until-valid validation including the
// percentage-requires-samplePercent rule. apiFetch + useCan are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// ---- mocks ----
const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBase: () => "http://localhost:8788",
  getAccessToken: () => "test-token",
}));

const can: Record<string, boolean> = {};
vi.mock("@/auth/AuthContext", () => ({
  useCan: (perm: string) => can[perm] ?? false,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import QAReview from "./QAReview";
import { SamplingPolicyDialog } from "@/components/qa-review/SamplingPolicyDialog";

const STATS = {
  inQueue: 3,
  reviewedToday: 1,
  avgReviewTimeMs: 4200,
  reviewerAgreementPct: 88,
  disputesOpen: 1,
  slaBreaches: 0,
  medianGoldVariance: 6,
};

function queueRow(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    recruiterUserId: null,
    recruiterName: "Asha R",
    candidateId: "22222222-2222-2222-2222-222222222222",
    candidateName: "Vikram S",
    demandId: null,
    demandTitle: "Senior Java Engineer",
    reviewCount: 0,
    latestDecision: null,
    aiScore: 72,
    reviewerScore: null,
    goldVariance: null,
    dueAt: null,
    slaBreached: false,
    assignedReviewerName: null,
    disputeStatus: null,
    ...over,
  };
}

// Route apiFetch by URL so each test controls just the queue payload.
function routeApi(queue: { rows: unknown[]; nextCursor: string | null; total: number } | Error) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path.startsWith("/api/qa/stats")) return Promise.resolve(STATS);
    if (path.startsWith("/api/qa/queue")) {
      if (queue instanceof Error) return Promise.reject(queue);
      return Promise.resolve(queue);
    }
    if (path.startsWith("/api/qa/policies")) return Promise.resolve({ policies: [], nextCursor: null });
    if (path.startsWith("/api/qa/disputes")) return Promise.resolve({ disputes: [], nextCursor: null });
    if (path.startsWith("/api/qa/calibration")) return Promise.resolve({ sessions: [], nextCursor: null });
    if (path.startsWith("/api/qa/agreement"))
      return Promise.resolve({ kappa: null, pairwise: [], driftAlerts: [], asOf: new Date().toISOString() });
    return Promise.resolve({});
  });
}

function renderPage(initialEntry = "/qa-review") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <QAReview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  for (const k of Object.keys(can)) delete can[k];
  can["qa.read"] = true;
  can["qa.write"] = true;
  can["qa.sampling"] = true;
});
afterEach(cleanup);

describe("QAReview permission gate", () => {
  it("shows an access panel without qa.read", () => {
    delete can["qa.read"];
    routeApi({ rows: [], nextCursor: null, total: 0 });
    renderPage();
    expect(screen.getByText(/don't have access to QA Review/i)).toBeInTheDocument();
  });
});

describe("QAReview queue states", () => {
  it("renders skeleton rows while loading", () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const { container } = renderPage();
    expect(container.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length).toBeGreaterThan(0);
  });

  it("shows first-run empty state with Create policy CTA when no filters", async () => {
    routeApi({ rows: [], nextCursor: null, total: 0 });
    renderPage();
    expect(await screen.findByText(/No calls sampled for review yet/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Create policy/i }).length).toBeGreaterThan(0);
  });

  it("shows a distinct filtered-to-zero state when filters are present", async () => {
    routeApi({ rows: [], nextCursor: null, total: 0 });
    renderPage("/qa-review?q=nobody");
    expect(await screen.findByText(/No calls match these filters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear filters/i })).toBeInTheDocument();
  });

  it("shows an inline error with the server message and a working Retry", async () => {
    const err = Object.assign(new Error("boom"), { body: { error: "queue_failed" } });
    routeApi(err);
    renderPage();
    expect(await screen.findByText(/Couldn't load the queue/i, undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/queue_failed/i)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /Retry/i });
    routeApi({ rows: [queueRow()], nextCursor: null, total: 1 });
    fireEvent.click(retry);
    expect(await screen.findByText("Vikram S", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("renders rows and a Grade action with qa.write", async () => {
    routeApi({ rows: [queueRow()], nextCursor: null, total: 1 });
    renderPage();
    expect(await screen.findByText("Vikram S")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 1/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Grade/i }).length).toBeGreaterThan(0);
  });
});

describe("QAReview enabled-CTA regression", () => {
  it("Create policy is enabled with qa.sampling and opens the dialog", async () => {
    routeApi({ rows: [], nextCursor: null, total: 0 });
    renderPage();
    await screen.findByText(/No calls sampled/i);
    const btns = screen.getAllByRole("button", { name: /Create policy/i });
    const enabled = btns.find((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled).toBeTruthy();
    fireEvent.click(enabled!);
    expect(await screen.findByText(/New sampling policy/i)).toBeInTheDocument();
  });

  it("Create policy is disabled (with reason) without qa.sampling — no toast", async () => {
    delete can["qa.sampling"];
    routeApi({ rows: [queueRow()], nextCursor: null, total: 1 });
    renderPage();
    await screen.findByText("Vikram S");
    const btn = screen.getByRole("button", { name: /Create policy/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", expect.stringMatching(/qa\.sampling/));
  });
});

describe("SamplingPolicyDialog validation", () => {
  function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SamplingPolicyDialog open onOpenChange={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("disables submit until name is filled (percentage default has a valid sample %)", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    const create = within(dialog).getByRole("button", { name: /Create policy/i });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Daily sample" } });
    await waitFor(() => expect(create).toBeEnabled());
  });

  it("percentage strategy requires a valid sample percent", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Daily" } });
    const pct = within(dialog).getByLabelText(/Sample percent/i);
    fireEvent.change(pct, { target: { value: "" } });
    const create = within(dialog).getByRole("button", { name: /Create policy/i });
    await waitFor(() => expect(create).toBeDisabled());
    expect(within(dialog).getByText(/percent between 0 and 100/i)).toBeInTheDocument();
    fireEvent.change(pct, { target: { value: "25" } });
    await waitFor(() => expect(create).toBeEnabled());
  });
});
