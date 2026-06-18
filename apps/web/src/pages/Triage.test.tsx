// Triage console — component tests (Vitest + jsdom).
//
// Covers the four distinct states (loading / first-run-empty / filtered-to-zero
// / error with inline Retry) on the Live board, the permission-gated create CTA
// + read-only badge, the analytics handoff-success metric reading from the
// mocked aggregate (NOT a hardcoded 96% literal), and the SLA badge column.
// apiFetch + useCan are mocked; React Router + React Query wrap.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// ---- mocks ----
const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBase: () => "http://localhost:8788",
  getAccessToken: () => "test-token",
}));

const canMap: Record<string, boolean> = {
  "triage.read": true,
  "triage.write": true,
  "triage.operate": true,
};
vi.mock("@/auth/AuthContext", () => ({
  useCan: (perm: string) => canMap[perm] ?? false,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Triage from "./Triage";

const emptyFlows = { flows: [] };
const emptyLive = { sessions: [], nextCursor: null, total: 0 };

function flow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "flow-1",
    name: "Front-desk Triage",
    purpose: "Inbound front-door classifier",
    status: "active",
    phoneNumber: "+918041000000",
    language: "multi",
    intentVocabulary: ["job_inquiry", "status_check", "other"],
    ruleCount: 3,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    voiceAgentId: "agent-1",
    ...over,
  };
}

function liveSession(over: Partial<Record<string, unknown>> = {}) {
  return {
    callId: "call-1",
    flowId: "flow-1",
    flowName: "Front-desk Triage",
    callerRef: "+919812340000",
    startedAt: new Date().toISOString(),
    elapsedSec: 42,
    status: "decided",
    classification: { intent: "job_inquiry", confidence: 0.88 },
    destinationLabel: "Front-desk Pod",
    destinationType: "human_team",
    slaTargetSec: 60,
    slaRemainingSec: 18,
    slaBreached: false,
    ...over,
  };
}

function analytics(over: Partial<Record<string, unknown>> = {}) {
  return {
    triagedToday: 12,
    avgTimeToRouteSec: 22,
    autoResolvedPct: 40,
    toHumanPct: 60,
    handoffSuccess24hPct: 73,
    noMatchRate: 4,
    fallbackRate: 9,
    slaAttainmentPct: 88,
    byIntent: [{ intent: "job_inquiry", count: 8 }],
    byDestination: [{ destination: "Front-desk Pod", human: 8, voiceAgent: 0 }],
    byRule: [
      {
        ruleId: "rule-1",
        intent: "job_inquiry",
        destinationLabel: "Front-desk Pod",
        decisions: 8,
        hitRatePct: 66,
        slaAttainmentPct: 90,
      },
    ],
    dailyVolume: [{ day: "2026-06-01", triaged: 5, handoffs: 4 }],
    asOf: new Date().toISOString(),
    ...over,
  };
}

// Route apiFetch by URL so the page's parallel hooks resolve.
function routeMock(impl: (url: string) => unknown) {
  apiFetchMock.mockImplementation((url: string) => {
    const result = impl(url);
    return result instanceof Promise ? result : Promise.resolve(result);
  });
}

function renderPage(initialEntries = ["/triage"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/triage" element={<Triage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  canMap["triage.read"] = true;
  canMap["triage.write"] = true;
  canMap["triage.operate"] = true;
});
afterEach(() => cleanup());

describe("Triage — Live board", () => {
  it("shows the first-run empty state (no calls in 24h) distinct from filtered-zero", async () => {
    routeMock((url) => {
      if (url.startsWith("/api/triage/flows")) return emptyFlows;
      if (url.startsWith("/api/triage/sessions/active")) return emptyLive;
      return {};
    });
    renderPage();
    expect(await screen.findByText(/No triage calls in the last 24 hours/i)).toBeInTheDocument();
    // First-run copy, not the filtered-zero copy.
    expect(screen.queryByText(/No calls match these filters/i)).not.toBeInTheDocument();
  });

  it("shows the filtered-to-zero state when a filter is in the URL", async () => {
    routeMock((url) => {
      if (url.startsWith("/api/triage/flows")) return { flows: [flow()] };
      if (url.startsWith("/api/triage/sessions/active")) return emptyLive;
      return {};
    });
    renderPage(["/triage?tab=Live&status=failed"]);
    expect(await screen.findByText(/No calls match these filters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear filters/i })).toBeInTheDocument();
  });

  it("renders a session row with an SLA badge", async () => {
    routeMock((url) => {
      if (url.startsWith("/api/triage/flows")) return { flows: [flow()] };
      if (url.startsWith("/api/triage/sessions/active"))
        return { sessions: [liveSession()], nextCursor: null, total: 1 };
      return {};
    });
    renderPage();
    expect(await screen.findByText("+919812340000")).toBeInTheDocument();
    // SlaBadge renders remaining time, by status text not color alone.
    expect(screen.getByText(/left/i)).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 1 call/i)).toBeInTheDocument();
  });

  it("surfaces an error state with a Retry that refetches", async () => {
    let calls = 0;
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/triage/flows")) return Promise.resolve({ flows: [flow()] });
      if (url.startsWith("/api/triage/sessions/active")) {
        calls += 1;
        if (calls === 1) {
          const err = Object.assign(new Error("boom"), {
            status: 500,
            body: { error: "internal_error" },
          });
          return Promise.reject(err);
        }
        return Promise.resolve({ sessions: [liveSession()], nextCursor: null, total: 1 });
      }
      return Promise.resolve({});
    });
    renderPage();
    expect(await screen.findByText(/Couldn’t load this view/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(await screen.findByText("+919812340000")).toBeInTheDocument();
  });
});

describe("Triage — permissions", () => {
  it("hides the create CTA + shows a read-only badge without triage.write", async () => {
    canMap["triage.write"] = false;
    routeMock((url) => {
      if (url.startsWith("/api/triage/flows")) return emptyFlows;
      if (url.startsWith("/api/triage/sessions/active")) return emptyLive;
      return {};
    });
    renderPage();
    await screen.findByText(/No triage calls/i);
    expect(screen.queryByRole("button", { name: /Create triage flow/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Read-only/i).length).toBeGreaterThan(0);
  });

  it("shows the create CTA with triage.write", async () => {
    routeMock((url) => {
      if (url.startsWith("/api/triage/flows")) return emptyFlows;
      if (url.startsWith("/api/triage/sessions/active")) return emptyLive;
      return {};
    });
    renderPage();
    await screen.findByText(/No triage calls/i);
    expect(screen.getByRole("button", { name: /Create triage flow/i })).toBeEnabled();
  });
});

describe("Triage — Analytics", () => {
  it("reads handoff-success from the live aggregate (no hardcoded 96%)", async () => {
    routeMock((url) => {
      if (url.startsWith("/api/triage/flows")) return { flows: [flow()] };
      if (url.startsWith("/api/triage/analytics")) return analytics({ handoffSuccess24hPct: 73 });
      if (url.startsWith("/api/triage/sessions/active")) return emptyLive;
      return {};
    });
    renderPage(["/triage?tab=Analytics"]);
    // The metric moves with the data — 73%, not a 96% literal.
    expect(await screen.findByText("73%")).toBeInTheDocument();
    expect(screen.queryByText("96%")).not.toBeInTheDocument();
    // The "as of" caption is present.
    expect(screen.getByTestId("analytics-asof")).toBeInTheDocument();
    // Per-rule hit-rate table renders from real data.
    expect(screen.getByText(/Rule hit-rate & SLA/i)).toBeInTheDocument();
  });

  it("metric changes when the mocked aggregate changes", async () => {
    routeMock((url) => {
      if (url.startsWith("/api/triage/flows")) return { flows: [flow()] };
      if (url.startsWith("/api/triage/analytics")) return analytics({ handoffSuccess24hPct: 51 });
      if (url.startsWith("/api/triage/sessions/active")) return emptyLive;
      return {};
    });
    renderPage(["/triage?tab=Analytics"]);
    expect(await screen.findByText("51%")).toBeInTheDocument();
  });
});

describe("Triage — Flows", () => {
  it("lists flow cards from the API", async () => {
    routeMock((url) => {
      if (url.startsWith("/api/triage/flows")) return { flows: [flow()] };
      if (url.startsWith("/api/triage/sessions/active")) return emptyLive;
      return {};
    });
    renderPage(["/triage?tab=Flows"]);
    const heading = await screen.findAllByText("Front-desk Triage");
    expect(heading.length).toBeGreaterThan(0);
  });
});
