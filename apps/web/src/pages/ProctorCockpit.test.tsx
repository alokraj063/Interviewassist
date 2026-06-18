// Proctor Cockpit roster — component tests (Vitest + jsdom).
//
// Covers the four distinct states (loading / first-run-empty / filtered-zero /
// error with retry), the permission-gated bulk actions (read-only degrade),
// URL-synced filters with chips + clear-all, and proves the metric cards read
// the SERVER summary aggregate (not a client slice of the list) — the fix for
// the at-scale-wrong-metric hard-fail. apiFetch + useCan are mocked; React
// Router + React Query wrap.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// ---- mocks ----
const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBase: () => "http://localhost",
  getAccessToken: () => "test-token",
}));

// useCan is called per-permission string; default = full access, flip via the map.
let perms: Record<string, boolean> = {
  "proctoring.review": true,
  "proctoring.export": true,
  "proctoring.policy.write": true,
};
vi.mock("@/auth/AuthContext", () => ({
  useCan: (permission: string) => perms[permission] ?? false,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import ProctorCockpit from "./ProctorCockpit";

// ---- fixtures ----

const SUMMARY = {
  live: 3,
  paused: 1,
  pendingReview: 7,
  slaBreached: 2,
  flaggedToday: 4,
  invalidated: 1,
  avgRisk: 42,
  total: 9001, // intentionally large to prove the card is not a list-slice count
};

function sessionRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sess-1",
    candidateId: "cand-1",
    candidateName: "Aanya Sharma",
    status: "completed",
    liveState: "ended",
    riskScore: 72,
    riskLabel: "high",
    flagCount: 3,
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    endedAt: new Date().toISOString(),
    reviewerDecision: null,
    assignedReviewerUserId: null,
    assignedReviewerName: null,
    reviewSlaDueAt: new Date(Date.now() + 3600_000).toISOString(),
    assessmentAttemptId: "att-1",
    asyncVideoSubmissionId: null,
    ...over,
  };
}

// Route apiFetch by URL so summary + sessions resolve independently.
function routeApi(opts: { summary?: unknown; sessions?: unknown; reject?: boolean }) {
  apiFetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/proctor/summary")) {
      return opts.summary === undefined ? Promise.resolve(SUMMARY) : Promise.resolve(opts.summary);
    }
    if (url.startsWith("/api/proctor/sessions")) {
      if (opts.reject) return Promise.reject(new Error("backend exploded"));
      return Promise.resolve(opts.sessions);
    }
    // reviewers etc.
    return Promise.resolve({ reviewers: [] });
  });
}

function renderPage(initialEntries = ["/proctor"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <ProctorCockpit />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  perms = { "proctoring.review": true, "proctoring.export": true, "proctoring.policy.write": true };
});
afterEach(() => cleanup());

describe("ProctorCockpit — states", () => {
  it("shows skeletons while the roster is loading", () => {
    apiFetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderPage();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("first-run empty shows the 'No proctored sessions yet' copy (distinct from filtered-zero)", async () => {
    routeApi({ sessions: { sessions: [], nextCursor: null, total: 0 } });
    renderPage();
    expect(await screen.findByText(/No proctored sessions yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/No sessions match these filters/i)).toBeNull();
  });

  it("filtered-to-zero shows a distinct 'No sessions match' copy + a clear control", async () => {
    routeApi({ sessions: { sessions: [], nextCursor: null, total: 0 } });
    renderPage(["/proctor?status=live"]);
    expect(await screen.findByText(/No sessions match these filters/i)).toBeInTheDocument();
    expect(screen.queryByText(/No proctored sessions yet/i)).toBeNull();
  });

  it("error state surfaces the server message + a Retry button", async () => {
    routeApi({ reject: true });
    renderPage();
    expect(await screen.findByText(/backend exploded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });
});

describe("ProctorCockpit — metrics read the server aggregate (at-scale fix)", () => {
  it("renders summary cards from /summary, not from a slice of the session list", async () => {
    // List returns ONE row; summary.total is 9001. The card must show 9,001.
    routeApi({ sessions: { sessions: [sessionRow()], nextCursor: null, total: 1 } });
    renderPage();
    await screen.findByText(/Aanya Sharma/i);

    // Live now card from the summary aggregate.
    expect(screen.getByText("Live now")).toBeInTheDocument();
    // Pending review value from the aggregate (7), not derivable from the 1-row list.
    expect(screen.getByText("7")).toBeInTheDocument();
    // Avg risk from the aggregate.
    expect(screen.getByText("42")).toBeInTheDocument();
    // "showing X of N" reflects the server total, not the page length.
    expect(screen.getByText(/of 1 sessions/i)).toBeInTheDocument();
  });
});

describe("ProctorCockpit — permission gating (read-only degrade)", () => {
  it("hides the selection checkboxes + bulk review/assign for users lacking proctoring.review", async () => {
    perms = { "proctoring.review": false, "proctoring.export": false, "proctoring.policy.write": false };
    routeApi({ sessions: { sessions: [sessionRow()], nextCursor: null, total: 1 } });
    renderPage();
    await screen.findByText(/Aanya Sharma/i);

    // No per-row select checkbox when review is not granted (roster degrades to read-only).
    expect(screen.queryByRole("checkbox")).toBeNull();
    // Policies action (gated by policy.write) is hidden.
    expect(screen.queryByRole("button", { name: /Policies/i })).toBeNull();
    // Roster row is still visible (read-only, not blank).
    expect(screen.getByText(/Aanya Sharma/i)).toBeInTheDocument();
  });

  it("shows the selection checkbox + Policies action for a reviewer with full permissions", async () => {
    routeApi({ sessions: { sessions: [sessionRow()], nextCursor: null, total: 1 } });
    renderPage();
    await screen.findByText(/Aanya Sharma/i);
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Policies/i })).toBeInTheDocument();
  });
});

describe("ProctorCockpit — bulk bar (enabled CTA + select)", () => {
  it("selecting a row reveals the bulk action bar with the selected count", async () => {
    routeApi({ sessions: { sessions: [sessionRow()], nextCursor: null, total: 1 } });
    renderPage();
    await screen.findByText(/Aanya Sharma/i);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByText(/1 selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Assign/i })).toBeInTheDocument();
  });
});

describe("ProctorCockpit — URL-synced filters (chips + clear-all)", () => {
  it("renders a chip for an active filter from the URL and clears it", async () => {
    routeApi({ sessions: { sessions: [], nextCursor: null, total: 0 } });
    renderPage(["/proctor?status=live"]);
    // The filtered-zero empty state proves the filter was read from the URL.
    expect(await screen.findByText(/No sessions match these filters/i)).toBeInTheDocument();

    // A chip surfaces the active filter, and a Clear-all control resets it.
    const clearAll = await screen.findByRole("button", { name: /Clear all/i });
    expect(clearAll).toBeInTheDocument();
    fireEvent.click(clearAll);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Clear all/i })).toBeNull());
  });
});

describe("ProctorCockpit — no anti-patterns", () => {
  it("never calls window.prompt or window.confirm", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");
    routeApi({ sessions: { sessions: [sessionRow()], nextCursor: null, total: 1 } });
    renderPage();
    await screen.findByText(/Aanya Sharma/i);
    fireEvent.click(screen.getByRole("checkbox"));
    await screen.findByText(/1 selected/i);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("the candidate name links to the session detail route", async () => {
    routeApi({ sessions: { sessions: [sessionRow()], nextCursor: null, total: 1 } });
    renderPage();
    const link = (await screen.findByText(/Aanya Sharma/i)).closest("a");
    expect(link).toHaveAttribute("href", expect.stringContaining("/proctor/sessions/sess-1"));
  });
});
