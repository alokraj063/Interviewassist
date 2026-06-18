// Team Monitor supervisor floor — component tests (Vitest + jsdom).
//
// Covers the four states (loading skeleton / first-run-empty distinct from
// filtered-to-zero with clear-filters / error with inline server message +
// Retry / permission read-only gating), the SLA dialog disabled-until-valid
// validation, the enabled-CTA regression (Whisper enabled with the permission,
// disabled without), and that no window.prompt/confirm is used. apiFetch +
// useCan are mocked; Router + Query wrap.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

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

import TeamMonitor from "./TeamMonitor";
import { SlaPolicyDialog, validateSla } from "@/components/team-monitor/SlaPolicyDialog";

const OVERVIEW = {
  kpis: {
    recruitersOnline: 3,
    onCall: 1,
    idle: 1,
    queueDepth: 2,
    activeCalls: 1,
    openAlerts: 2,
    criticalAlerts: 1,
  },
  presenceByActivity: { on_call: 1, idle: 1, in_meeting: 1, offline: 0 },
  openAlerts: { info: 0, warning: 1, critical: 1 },
};

const emptyPage = { rows: [], nextCursor: null };

function liveCall(over: Record<string, unknown> = {}) {
  return {
    id: "call-1",
    status: "active",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    recruiterUserId: "rec-1",
    recruiterName: "Asha R",
    recruiterEmail: "asha@x.local",
    candidateId: "cand-1",
    candidateName: "Vikram S",
    demandId: "dem-1",
    demandTitle: "Backend Engineer",
    durationMs: 60_000,
    supervisionMode: null,
    ...over,
  };
}

function routeMock(impl: (url: string) => unknown) {
  apiFetchMock.mockImplementation((url: string) => {
    const r = impl(url);
    return r instanceof Promise ? r : Promise.resolve(r);
  });
}

// Default handler: overview + heartbeat ok, all lists empty.
function defaultRoutes(url: string) {
  if (url.includes("/overview")) return OVERVIEW;
  if (url.includes("/presence/heartbeat")) return {};
  if (url.includes("/roster")) return emptyPage;
  if (url.includes("/live-calls")) return emptyPage;
  if (url.includes("/alerts")) return emptyPage;
  if (url.includes("/sla-policies")) return { policies: [] };
  return {};
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

function renderPage(entries = ["/team-monitor"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={entries}>
        <Routes>
          <Route
            path="/team-monitor"
            element={
              <>
                <TeamMonitor />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  for (const k of Object.keys(can)) delete can[k];
  can["team_monitor.read"] = true;
  can["team_monitor.supervise"] = true;
  can["team_monitor.reassign"] = true;
  can["team_monitor.alerts.write"] = true;
  can["team_monitor.sla.write"] = true;
});
afterEach(() => cleanup());

describe("TeamMonitor — states", () => {
  it("shows skeletons before live-call data arrives", () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes("/overview")) return Promise.resolve(OVERVIEW);
      if (url.includes("/heartbeat")) return Promise.resolve({});
      return new Promise(() => {}); // never resolves → loading
    });
    const { container } = renderPage();
    expect(container.querySelector('[data-testid="skeleton-rows"]')).toBeTruthy();
  });

  it("first-run empty roster shows the clocked-in copy (distinct from filtered)", async () => {
    routeMock(defaultRoutes);
    renderPage();
    expect(await screen.findByText(/no live or queued calls right now/i)).toBeInTheDocument();
    expect(screen.getByText(/no recruiters are clocked in yet/i)).toBeInTheDocument();
  });

  it("filtered-to-zero roster shows the no-match + clear-filters state", async () => {
    routeMock(defaultRoutes);
    renderPage(["/team-monitor?activity=idle"]);
    expect(await screen.findAllByText(/no matches for these filters/i)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /clear filters/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("error state surfaces the server message + a Retry that refetches", async () => {
    const err = Object.assign(new Error("boom"), { body: { error: "live_calls_failed" } });
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes("/overview")) return Promise.resolve(OVERVIEW);
      if (url.includes("/heartbeat")) return Promise.resolve({});
      if (url.includes("/live-calls")) return Promise.reject(err);
      return Promise.resolve(emptyPage);
    });
    renderPage();
    expect(await screen.findByText("live_calls_failed")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /retry/i });
    const before = apiFetchMock.mock.calls.filter((c) => String(c[0]).includes("/live-calls")).length;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.filter((c) => String(c[0]).includes("/live-calls")).length,
      ).toBeGreaterThan(before),
    );
  });

  it("renders a live call row with supervise action", async () => {
    routeMock((url) => (url.includes("/live-calls") ? { rows: [liveCall()], nextCursor: null } : defaultRoutes(url)));
    renderPage();
    expect(await screen.findByText("Vikram S")).toBeInTheDocument();
    expect(screen.getByTestId("supervise-call-1")).toBeInTheDocument();
  });
});

describe("TeamMonitor — permission gating", () => {
  it("read-only user (no supervise perm) gets a disabled Supervise button (enabled-CTA regression)", async () => {
    can["team_monitor.supervise"] = false;
    routeMock((url) => (url.includes("/live-calls") ? { rows: [liveCall()], nextCursor: null } : defaultRoutes(url)));
    renderPage();
    await screen.findByText("Vikram S");
    expect(screen.getByTestId("supervise-call-1")).toBeDisabled();
  });

  it("supervisor (with perm) gets an enabled Supervise button on an active call", async () => {
    can["team_monitor.supervise"] = true;
    routeMock((url) => (url.includes("/live-calls") ? { rows: [liveCall()], nextCursor: null } : defaultRoutes(url)));
    renderPage();
    await screen.findByText("Vikram S");
    expect(screen.getByTestId("supervise-call-1")).toBeEnabled();
  });

  it("without team_monitor.read the whole page is a permission wall", async () => {
    can["team_monitor.read"] = false;
    routeMock(defaultRoutes);
    renderPage();
    expect(await screen.findByText(/don't have access to the team monitor/i)).toBeInTheDocument();
  });
});

describe("TeamMonitor — URL sync", () => {
  it("an activity filter from the URL survives and renders the filtered-empty state", async () => {
    routeMock(defaultRoutes);
    renderPage(["/team-monitor?activity=idle"]);
    // The filtered-to-zero copy (not the first-run copy) confirms the URL param
    // flowed into the roster query.
    expect(await screen.findAllByText(/no matches for these filters/i)).toBeTruthy();
    expect(screen.getByTestId("loc").textContent).toContain("activity=idle");
  });

  it("switching to the alerts tab reflects in the URL", async () => {
    routeMock(defaultRoutes);
    renderPage();
    const floor = await screen.findByRole("tab", { name: /floor/i });
    // Radix tabs use automatic activation on keyboard focus move; click is
    // unreliable in jsdom, so drive the roving tabindex with ArrowRight.
    floor.focus();
    fireEvent.keyDown(floor, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toContain("tab=alerts"));
  });
});

describe("SlaPolicyDialog — validation", () => {
  const policy = {
    id: "p1",
    metric: "queue_depth" as const,
    warningThreshold: 5,
    criticalThreshold: 10,
    enabled: true,
    scopeLeadUserId: null,
    notifyUserId: null,
    updatedByUserId: null,
    updatedAt: new Date().toISOString(),
  };

  function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SlaPolicyDialog policy={policy} open onOpenChange={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("validateSla rejects equal thresholds and bad ordering", () => {
    expect(validateSla("queue_depth", 5, 5)).toMatch(/differ/i);
    expect(validateSla("queue_depth", 10, 5)).toMatch(/higher/i);
    expect(validateSla("queue_depth", 5, 10)).toBeNull();
    // answer_rate is lower-worse: critical must be below warning
    expect(validateSla("answer_rate", 8000, 9000)).toMatch(/lower/i);
    expect(validateSla("answer_rate", 8000, 6000)).toBeNull();
  });

  it("Save is disabled when warning == critical, enabled when valid", async () => {
    renderDialog();
    const save = await screen.findByTestId("sla-save");
    const warning = screen.getByLabelText(/warning threshold/i);
    const critical = screen.getByLabelText(/critical threshold/i);
    fireEvent.change(warning, { target: { value: "10" } });
    fireEvent.change(critical, { target: { value: "10" } });
    expect(save).toBeDisabled();
    expect(screen.getByTestId("sla-validation")).toBeInTheDocument();
    fireEvent.change(critical, { target: { value: "20" } });
    await waitFor(() => expect(save).toBeEnabled());
  });
});

describe("TeamMonitor — no anti-patterns", () => {
  it("never calls window.prompt or window.confirm", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");
    routeMock(defaultRoutes);
    renderPage();
    await screen.findByText(/no recruiters are clocked in yet/i);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
