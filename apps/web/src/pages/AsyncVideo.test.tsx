// Async Video list — component tests (Vitest + jsdom).
//
// Covers the four distinct states (loading / first-run-empty / filtered-to-zero
// / error with inline Retry), the permission-gated New-campaign CTA, the
// builder-dialog open + disabled-until-valid behaviour, the explicit assertion
// that window.prompt is NEVER used for create (the page's old hard-fail), and
// URL filter sync. apiFetch + useCan are mocked; React Router + React Query wrap.
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

let canWrite = true;
let canInvite = true;
vi.mock("@/auth/AuthContext", () => ({
  useCan: (perm: string) => (perm === "async_video.write" ? canWrite : canInvite),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import AsyncVideo from "./AsyncVideo";

function emptyCampaigns() {
  return { campaigns: [], nextCursor: null, total: 0 };
}
function emptyQueue() {
  return { submissions: [], nextCursor: null, total: 0 };
}

// Route apiFetch by URL so both list hooks (campaigns + queue) resolve.
function routeMock(impl: (url: string) => unknown) {
  apiFetchMock.mockImplementation((url: string) => {
    const result = impl(url);
    return result instanceof Promise ? result : Promise.resolve(result);
  });
}

// Surfaces the current location.search so URL-sync assertions can read it.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

function renderPage(initialEntries = ["/async-video"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route
            path="/async-video"
            element={
              <>
                <AsyncVideo />
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
  canWrite = true;
  canInvite = true;
});
afterEach(() => cleanup());

describe("AsyncVideo list — states", () => {
  it("shows a loading skeleton before data arrives", () => {
    apiFetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderPage();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("first-run empty shows the create-your-first copy (distinct from filtered)", async () => {
    routeMock((url) => (url.includes("/queue") ? emptyQueue() : emptyCampaigns()));
    renderPage();
    expect(await screen.findByText(/create your first video screen/i)).toBeInTheDocument();
  });

  it("filtered-to-zero shows a 'no campaigns match' clear-filters state", async () => {
    routeMock((url) => (url.includes("/queue") ? emptyQueue() : emptyCampaigns()));
    renderPage(["/async-video?status=published"]);
    expect(await screen.findByText(/no campaigns match these filters/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /clear filters/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("error state shows the server message + a Retry that refetches", async () => {
    const err = Object.assign(new Error("boom"), { body: { error: "campaigns_failed" } });
    apiFetchMock.mockRejectedValue(err);
    renderPage();
    expect(await screen.findByText("campaigns_failed")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /retry/i });
    const callsBefore = apiFetchMock.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});

describe("AsyncVideo — create flow (no window.prompt)", () => {
  it("New campaign opens the builder dialog; window.prompt is NEVER called", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    routeMock((url) => (url.includes("/queue") ? emptyQueue() : emptyCampaigns()));
    renderPage();

    await screen.findByText(/create your first video screen/i);
    fireEvent.click(screen.getAllByRole("button", { name: /new campaign/i })[0]);

    // The builder dialog mounts (title rendered) — not a native prompt().
    expect(await screen.findByText(/new video screen/i)).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();

    // Submit is disabled until a title + at least one question are valid.
    const submit = screen.getByRole("button", { name: /create video screen/i });
    expect(submit).toBeDisabled();
    promptSpy.mockRestore();
  });
});

describe("AsyncVideo — permission gating", () => {
  it("a user without async_video.write sees a disabled New-campaign CTA", async () => {
    canWrite = false;
    routeMock((url) => (url.includes("/queue") ? emptyQueue() : emptyCampaigns()));
    renderPage();
    await screen.findByText(/create your first video screen/i);
    const cta = screen.getAllByRole("button", { name: /new campaign/i })[0];
    expect(cta).toBeDisabled();
  });
});

describe("AsyncVideo — URL filter sync", () => {
  it("a status filter present in the URL drives the filtered-zero state", async () => {
    routeMock((url) => (url.includes("/queue") ? emptyQueue() : emptyCampaigns()));
    renderPage(["/async-video?status=published"]);
    // status in the URL ⇒ hasFilters ⇒ filtered-to-zero empty copy, and the
    // status query param is preserved in the location.
    expect(await screen.findByText(/no campaigns match these filters/i)).toBeInTheDocument();
    expect(screen.getByTestId("location-search").textContent).toContain("status=published");
  });

  it("typing in the search box debounces into the URL (?q=react)", async () => {
    routeMock((url) => (url.includes("/queue") ? emptyQueue() : emptyCampaigns()));
    renderPage();
    await screen.findByText(/create your first video screen/i);

    const search = screen.getByLabelText("Search");
    fireEvent.change(search, { target: { value: "react" } });

    await waitFor(
      () => expect(screen.getByTestId("location-search").textContent).toContain("q=react"),
      { timeout: 2000 },
    );
  });
});
