// Knowledge Base — component tests (Vitest + jsdom).
//
// Covers: loading skeleton (not a bare "Loading…" string), first-run-empty
// (collections=[]) distinct from filtered-to-zero, error state with server
// message + Retry → refetch, AddSourceDialog enabled-CTA validation (name +
// collection + files all required — regression vs the old dead corpus picker),
// permission gating of the New collection / Add source CTAs. apiFetch + useCan
// are mocked; no real network.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBase: () => "http://localhost:8788",
  getAccessToken: () => "test-token",
  getStoredToken: () => "test-token",
}));

const can: Record<string, boolean> = {};
vi.mock("@/auth/AuthContext", () => ({
  useCan: (perm: string) => can[perm] ?? false,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import Knowledge from "./Knowledge";
import { AddSourceDialog } from "@/components/knowledge/AddSourceDialog";

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
    return Promise.resolve({});
  });
}

const EMPTY_ANALYTICS = {
  days: 7,
  totals: { retrievals: 0, zeroResult: 0, avgLatencyMs: null, retrievals7d: 0 },
  byDay: [],
  topSources: [],
  contentGaps: [],
  staleness: { stale: 0, deprecated: 0, total: 0 },
};

function renderPage(initialEntry = "/knowledge?tab=collections") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Knowledge />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const k of Object.keys(can)) delete can[k];
  apiFetchMock.mockReset();
});
afterEach(() => cleanup());

describe("Knowledge Base — Collections tab states", () => {
  it("shows loading skeletons, not a bare Loading string", () => {
    routeApi({
      "/api/kb/analytics": () => new Promise(() => {}),
      "/api/kb/collections": () => new Promise(() => {}),
    });
    const { container } = renderPage();
    // skeleton placeholders render (animate-pulse), and there is no literal "Loading…" text.
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    expect(screen.queryByText(/^Loading…$/)).toBeNull();
  });

  it("first-run empty shows distinct create-collection copy + enabled CTA", async () => {
    can["knowledge.manage"] = true;
    routeApi({
      "/api/kb/analytics": EMPTY_ANALYTICS,
      "/api/kb/collections": { collections: [], nextCursor: null, total: 0 },
    });
    renderPage();
    expect(await screen.findByText(/No collections yet/i)).toBeInTheDocument();
    const cta = screen.getByRole("button", { name: /Create collection/i });
    expect(cta).toBeEnabled();
  });

  it("error state surfaces the server message and Retry refetches", async () => {
    can["knowledge.manage"] = true;
    let calls = 0;
    apiFetchMock.mockImplementation((path: string) => {
      if (path.includes("/api/kb/analytics")) return Promise.resolve(EMPTY_ANALYTICS);
      if (path.includes("/api/kb/collections")) {
        calls++;
        if (calls === 1) return Promise.reject(new Error("kaboom from server"));
        return Promise.resolve({ collections: [], nextCursor: null, total: 0 });
      }
      return Promise.resolve({});
    });
    renderPage();
    expect(await screen.findByText(/kaboom from server/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => expect(screen.queryByText(/kaboom from server/i)).toBeNull());
  });
});

describe("Knowledge Base — permission gating", () => {
  it("hides write CTAs (disabled with reason) without permissions", async () => {
    routeApi({
      "/api/kb/analytics": EMPTY_ANALYTICS,
      "/api/kb/collections": { collections: [], nextCursor: null, total: 0 },
    });
    renderPage();
    await screen.findByText(/No collections yet/i);
    const newCollection = screen.getByRole("button", { name: /New collection/i });
    expect(newCollection).toBeDisabled();
    expect(newCollection).toHaveAttribute("title", expect.stringMatching(/knowledge\.manage/));
    const addSource = screen.getByRole("button", { name: /Add source/i });
    expect(addSource).toBeDisabled();
  });

  it("enables write CTAs with permissions", async () => {
    can["knowledge.manage"] = true;
    can["knowledge.write"] = true;
    routeApi({
      "/api/kb/analytics": EMPTY_ANALYTICS,
      "/api/kb/collections": { collections: [], nextCursor: null, total: 0 },
    });
    renderPage();
    await screen.findByText(/No collections yet/i);
    expect(screen.getByRole("button", { name: /New collection/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Add source/i })).toBeEnabled();
  });
});

describe("AddSourceDialog — enabled-CTA validation", () => {
  function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AddSourceDialog open onOpenChange={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("disables Add source until name + collection + files are all set", async () => {
    routeApi({
      "/api/kb/collections": {
        collections: [
          {
            id: "col-1",
            name: "JD library",
            description: null,
            corpus: "jd",
            status: "active",
            staleAfterDays: 30,
            createdAt: null,
            updatedAt: null,
            sourceCount: 0,
            docCount: 0,
            retrievals7d: 0,
          },
        ],
        nextCursor: null,
        total: 1,
      },
    });
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: /Add source/i });
    // Initially disabled (no name, no collection, no files).
    expect(submit).toBeDisabled();

    // Fill name only — still disabled (collection + files missing).
    fireEvent.change(within(dialog).getByLabelText(/Source name/i), {
      target: { value: "New JD" },
    });
    expect(submit).toBeDisabled();

    // Add a file but no collection — still disabled.
    const fileInput = within(dialog).getByLabelText(/Documents/i) as HTMLInputElement;
    const file = new File(["hello"], "jd.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(submit).toBeDisabled();
  });
});
