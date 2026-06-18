// Analytics — component tests (Vitest + jsdom).
//
// Covers: loading skeleton (not a bare "Loading…" string), first-run-empty vs
// filtered-to-zero distinct copy, error state with server message + Retry that
// refetches, no fabricated/"illustrative" data (funnel renders from mocked API
// rows and the count moves with the mock), Save-view dialog enabled-CTA
// validation, and export/diversity permission gating. apiFetch + useCan mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// recharts ResponsiveContainer needs a non-zero size in jsdom; stub it out.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    ),
  };
});

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

import Analytics from "./Analytics";
import { SaveViewDialog } from "@/components/analytics/SavedViewMenu";

function SavedViewDialogHarness() {
  return (
    <SaveViewDialog
      open
      onOpenChange={() => {}}
      filters={{ range: "last_30d", compare: false, granularity: "day" }}
      tab="funnel"
    />
  );
}

// Route apiFetch by URL path so each report drives its own state.
type Handler = (path: string) => unknown;
function routeApi(handlers: Record<string, Handler | unknown>) {
  apiFetchMock.mockImplementation((path: string) => {
    for (const [frag, h] of Object.entries(handlers)) {
      if (path.includes(frag)) {
        const v = typeof h === "function" ? (h as Handler)(path) : h;
        if (v instanceof Error) return Promise.reject(v);
        if (v instanceof Promise) return v;
        return Promise.resolve(v);
      }
    }
    // Default: empty rows for any unmocked report.
    return Promise.resolve({ rows: [], asOf: new Date().toISOString(), window: {}, nextCursor: null });
  });
}

function funnelResp(counts: number[]) {
  const labels = ["Internal Review", "Client Submit", "Interview", "Final Select", "Offer", "Onboarded"];
  return {
    rows: labels.map((label, i) => ({
      bucket: label.toLowerCase().replace(/ /g, "_"),
      label,
      count: counts[i] ?? 0,
      conversionPctFromPrev: i === 0 ? null : 50,
    })),
    asOf: "2026-06-05T10:00:00.000Z",
    window: { from: "2026-05-06T00:00:00.000Z", to: "2026-06-05T00:00:00.000Z" },
  };
}

function renderPage(entry = "/analytics") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Analytics />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  for (const k of Object.keys(can)) delete can[k];
  can["analytics.read"] = true;
  can["analytics.export"] = true;
});
afterEach(cleanup);

describe("Analytics funnel tab", () => {
  it("shows a loading skeleton (not a bare 'Loading…' string)", () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}));
    const { container } = renderPage();
    expect(screen.queryByText(/^Loading…$/)).toBeNull();
    expect(container.querySelector('[data-testid="chart-skeleton"]')).toBeTruthy();
  });

  it("renders the funnel from API rows and the count moves with the mock (no fabricated data)", async () => {
    routeApi({ "reports/funnel": funnelResp([40, 20, 10, 5, 3, 2]) });
    renderPage();
    const cell = await screen.findByTestId("funnel-count-internal_review");
    expect(cell).toHaveTextContent("40");
    // Mutate the mock + remount → DOM count changes (nothing hardcoded).
    cleanup();
    routeApi({ "reports/funnel": funnelResp([99, 20, 10, 5, 3, 2]) });
    renderPage();
    expect(await screen.findByTestId("funnel-count-internal_review")).toHaveTextContent("99");
  });

  it("has no 'illustrative' fabricated chart copy anywhere", async () => {
    routeApi({ "reports/funnel": funnelResp([10, 5, 2, 1, 1, 1]) });
    const { container } = renderPage();
    await screen.findByTestId("funnel-count-internal_review");
    expect(container.textContent ?? "").not.toMatch(/illustrative/i);
  });

  it("first-run-empty shows distinct copy from filtered-to-zero", async () => {
    routeApi({ "reports/funnel": funnelResp([0, 0, 0, 0, 0, 0]) });
    renderPage();
    expect(await screen.findByText(/No data in this period yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/No results for these filters/i)).toBeNull();
  });

  it("filtered-to-zero (segment applied) shows the filtered empty copy + Clear filters", async () => {
    routeApi({ "reports/funnel": funnelResp([0, 0, 0, 0, 0, 0]) });
    renderPage("/analytics?source=naukri");
    expect(await screen.findByText(/No results for these filters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear filters/i })).toBeInTheDocument();
  });

  it("renders an error with the server message + Retry that refetches", async () => {
    const err = Object.assign(new Error("HTTP 500"), { body: { error: "db_unavailable" } });
    let calls = 0;
    apiFetchMock.mockImplementation((path: string) => {
      if (path.includes("reports/funnel")) {
        calls += 1;
        if (calls === 1) return Promise.reject(err);
        return Promise.resolve(funnelResp([7, 3, 1, 1, 1, 1]));
      }
      return Promise.resolve({ rows: [], asOf: new Date().toISOString(), window: {}, nextCursor: null });
    });
    renderPage();
    expect(await screen.findByText(/db_unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(await screen.findByTestId("funnel-count-internal_review")).toHaveTextContent("7");
  });

  it("shows an 'as of' timestamp on the chart header", async () => {
    routeApi({ "reports/funnel": funnelResp([10, 5, 2, 1, 1, 1]) });
    renderPage();
    const asOf = await screen.findAllByTestId("as-of");
    expect(asOf[0]).toHaveTextContent(/as of/i);
  });
});

describe("Analytics saved-view validation", () => {
  // Drive the SavedViewMenu's Save dialog directly — Radix dropdown portals are
  // unreliable to open in jsdom, but the dialog (the validation surface, i.e.
  // the enabled-CTA regression) is the load-bearing assertion.
  it("disables the Save button until a name is entered, then enables it", async () => {
    apiFetchMock.mockResolvedValue({ rows: [], nextCursor: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SavedViewDialogHarness />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const submit = await screen.findByTestId("save-view-submit");
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Q2 Funnel Health" } });
    await waitFor(() => expect(submit).toBeEnabled());
  });
});

describe("Analytics permission gating", () => {
  it("disables Export with a reason when analytics.export is absent", async () => {
    can["analytics.export"] = false;
    routeApi({ "reports/funnel": funnelResp([10, 5, 2, 1, 1, 1]) });
    renderPage();
    await screen.findByTestId("funnel-count-internal_review");
    const disabled = screen.getAllByTestId("export-disabled")[0];
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute("title", expect.stringMatching(/analytics\.export/));
  });

  it("hides the Diversity tab without analytics.diversity.read", async () => {
    can["analytics.diversity.read"] = false;
    routeApi({ "reports/funnel": funnelResp([10, 5, 2, 1, 1, 1]) });
    renderPage();
    await screen.findByTestId("funnel-count-internal_review");
    const tablist = screen.getByRole("tablist");
    expect(within(tablist).queryByRole("tab", { name: /Diversity/i })).toBeNull();
  });

  it("shows the Diversity tab with the permission", async () => {
    can["analytics.diversity.read"] = true;
    routeApi({ "reports/funnel": funnelResp([10, 5, 2, 1, 1, 1]) });
    renderPage();
    await screen.findByTestId("funnel-count-internal_review");
    const tablist = screen.getByRole("tablist");
    expect(within(tablist).getByRole("tab", { name: /Diversity/i })).toBeInTheDocument();
  });
});
