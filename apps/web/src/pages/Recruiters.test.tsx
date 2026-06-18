// Recruiters leaderboard — component tests (Vitest + jsdom).
//
// Covers the four distinct states (loading skeleton / first-run-empty with the
// invite CTA / filtered-to-zero with clear-all / error with inline Retry), the
// permission gating of the manage actions, the goal-dialog disabled-until-valid
// + invalid-date-range validation, the enabled-CTA regression, and that
// window.prompt is NEVER used. apiFetch + useCan are mocked; Router + Query wrap.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// ---- mocks ----
const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBase: () => "http://localhost:8788",
  getAccessToken: () => "test-token",
}));

let canManage = true;
vi.mock("@/auth/AuthContext", () => ({
  useCan: (perm: string) => (perm === "recruiters.manage" ? canManage : true),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import Recruiters from "./Recruiters";
import { GoalDialog } from "@/components/recruiters/GoalDialog";

function emptyList() {
  return { rows: [], nextCursor: null, total: 0, window: "30d", asOf: new Date().toISOString() };
}

function oneRow() {
  return {
    rows: [
      {
        id: "r1",
        email: "recruiter1@x.local",
        name: "Asha R",
        avatarUrl: null,
        role: "recruiter",
        status: "active",
        joinedAt: null,
        lastActiveAt: null,
        reportingToUserId: null,
        submissions: 12,
        clientSubmits: 8,
        selects: 4,
        offers: 2,
        joins: 1,
        calls: 20,
        slaBreaches: 1,
        conversion: 3300,
        activeDemands: 11,
        maxActiveDemands: 8,
        loadPct: 137,
        overAllocated: true,
        goalAttainmentPct: 80,
        trendSpark: [1, 2, 3, 4, 2, 5, 3, 6],
      },
    ],
    nextCursor: null,
    total: 1,
    window: "30d",
    asOf: new Date().toISOString(),
  };
}

function routeMock(impl: (url: string) => unknown) {
  apiFetchMock.mockImplementation((url: string) => {
    const result = impl(url);
    return result instanceof Promise ? result : Promise.resolve(result);
  });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

function renderPage(initialEntries = ["/recruiters"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route
            path="/recruiters"
            element={
              <>
                <Recruiters />
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
  canManage = true;
});
afterEach(() => cleanup());

describe("Recruiters list — states", () => {
  it("shows skeleton rows before data arrives", () => {
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("first-run empty shows the invite CTA (distinct from filtered)", async () => {
    routeMock((url) => (url.includes("/leaderboards") ? { leaderboards: [] } : emptyList()));
    renderPage();
    expect(await screen.findByText(/no recruiters yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /invite team/i })).toBeInTheDocument();
  });

  it("filtered-to-zero shows the no-match + clear-all state (different copy)", async () => {
    routeMock((url) => (url.includes("/leaderboards") ? { leaderboards: [] } : emptyList()));
    renderPage(["/recruiters?q=zzz"]);
    expect(await screen.findByText(/no recruiters match these filters/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /clear all/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("error state shows the server message + a Retry that refetches", async () => {
    const err = Object.assign(new Error("boom"), { body: { error: "recruiters_failed" } });
    apiFetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/leaderboards")) return Promise.resolve({ leaderboards: [] });
      return Promise.reject(err);
    });
    renderPage();
    expect(await screen.findByText("recruiters_failed")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /retry/i });
    const before = apiFetchMock.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("renders live KPI cells + the over-capacity warning for a real row", async () => {
    routeMock((url) => (url.includes("/leaderboards") ? { leaderboards: [] } : oneRow()));
    renderPage();
    expect(await screen.findByText("Asha R")).toBeInTheDocument();
    expect(screen.getByText("33.0%")).toBeInTheDocument(); // conversion bps formatted
    expect(screen.getByText(/over capacity 11\/8/i)).toBeInTheDocument();
  });
});

describe("Recruiters — permission gating", () => {
  it("without recruiters.manage the Save-view CTA is disabled", async () => {
    canManage = false;
    routeMock((url) => (url.includes("/leaderboards") ? { leaderboards: [] } : emptyList()));
    renderPage();
    await screen.findByText(/no recruiters yet/i);
    expect(screen.getByRole("button", { name: /save view/i })).toBeDisabled();
  });

  it("with recruiters.manage the Save-view CTA is enabled (enabled-CTA regression)", async () => {
    canManage = true;
    routeMock((url) => (url.includes("/leaderboards") ? { leaderboards: [] } : emptyList()));
    renderPage();
    await screen.findByText(/no recruiters yet/i);
    expect(screen.getByRole("button", { name: /save view/i })).toBeEnabled();
  });
});

describe("Recruiters — URL sync + no window.prompt", () => {
  it("typing search debounces into the URL (?q=asha)", async () => {
    routeMock((url) => (url.includes("/leaderboards") ? { leaderboards: [] } : emptyList()));
    renderPage();
    await screen.findByText(/no recruiters yet/i);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "asha" } });
    await waitFor(
      () => expect(screen.getByTestId("location-search").textContent).toContain("q=asha"),
      { timeout: 2000 },
    );
  });

  it("window.prompt is never called when opening the save-view dialog", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    routeMock((url) => (url.includes("/leaderboards") ? { leaderboards: [] } : emptyList()));
    renderPage();
    await screen.findByText(/no recruiters yet/i);
    fireEvent.click(screen.getByRole("button", { name: /save view/i }));
    expect(await screen.findByText(/save leaderboard view/i)).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });
});

// ---- GoalDialog validation (the A2 authoring contract) ----
function renderGoalDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GoalDialog open onOpenChange={() => {}} recruiterId="r1" recruiterName="Asha R" editing={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("GoalDialog — validation", () => {
  it("submit is enabled by default with a valid quarter template, fires the mutation", async () => {
    apiFetchMock.mockResolvedValue({ goal: { id: "g1" } });
    renderGoalDialog();
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: /set goal/i });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some((c) => String(c[0]).match(/\/api\/recruiters\/r1\/goals/)),
      ).toBe(true),
    );
  });

  it("an invalid date range disables submit and shows an inline error", async () => {
    renderGoalDialog();
    const dialog = screen.getByRole("dialog");
    const end = within(dialog).getByLabelText(/period end/i) as HTMLInputElement;
    const start = within(dialog).getByLabelText(/period start/i) as HTMLInputElement;
    // Make end <= start.
    fireEvent.change(start, { target: { value: "2026-06-01" } });
    fireEvent.change(end, { target: { value: "2026-05-01" } });
    expect(within(dialog).getByText(/period end must be after period start/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /set goal/i })).toBeDisabled();
  });

  it("a negative target disables submit with an inline error", async () => {
    renderGoalDialog();
    const dialog = screen.getByRole("dialog");
    const target = within(dialog).getByLabelText(/target value/i) as HTMLInputElement;
    fireEvent.change(target, { target: { value: "-3" } });
    expect(within(dialog).getByText(/whole number ≥ 0/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /set goal/i })).toBeDisabled();
  });
});
