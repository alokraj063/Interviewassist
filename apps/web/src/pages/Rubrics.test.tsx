// Rubrics list — component tests (Vitest + jsdom).
// Covers the four distinct states (loading / first-run-empty / filtered-zero /
// error), the permission-gated CTA, and the create-dialog disabled-until-valid
// regression. apiFetch + useCan are mocked; React Router + React Query wrap.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// ---- mocks ----
const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let canWrite = true;
vi.mock("@/auth/AuthContext", () => ({
  useCan: () => canWrite,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Rubrics from "./Rubrics";

function emptyList(filtered = false) {
  return {
    rubrics: [],
    nextCursor: null,
    total: 0,
    metrics: { published: 0, defaults: 0, timesScored: 0 },
    _filtered: filtered,
  };
}

function renderPage(initialEntries = ["/rubrics"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Rubrics />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  canWrite = true;
});
afterEach(() => cleanup());

describe("Rubrics list — states", () => {
  it("shows skeletons while loading", () => {
    apiFetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderPage();
    // Skeletons render with animate-pulse class from shadcn Skeleton.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("first-run empty shows the create-your-first copy (distinct from filtered-zero)", async () => {
    apiFetchMock.mockResolvedValue(emptyList(false));
    renderPage();
    expect(await screen.findByText(/No rubrics yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Create your first rubric/i)).toBeInTheDocument();
  });

  it("filtered-to-zero shows a distinct 'no rubrics match' copy + Clear filters", async () => {
    apiFetchMock.mockResolvedValue(emptyList(true));
    renderPage(["/rubrics?q=zzz"]);
    expect(await screen.findByText(/No rubrics match these filters/i)).toBeInTheDocument();
    // "Clear filters" appears both in the filter bar and in the empty state.
    expect(screen.getAllByRole("button", { name: /Clear filters/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("error state surfaces the server message + a Retry button", async () => {
    apiFetchMock.mockRejectedValue(new Error("backend exploded"));
    renderPage();
    expect(await screen.findByText(/Couldn't load rubrics/i)).toBeInTheDocument();
    expect(screen.getByText(/backend exploded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });
});

describe("Rubrics list — permission gating", () => {
  it("hides the New rubric CTA for read-only users", async () => {
    canWrite = false;
    apiFetchMock.mockResolvedValue(emptyList(false));
    renderPage();
    await screen.findByText(/No rubrics yet/i);
    expect(screen.queryByRole("button", { name: /New rubric/i })).toBeNull();
    expect(screen.getByText(/Read-only/i)).toBeInTheDocument();
  });

  it("shows the New rubric CTA for users with rubrics.write", async () => {
    canWrite = true;
    apiFetchMock.mockResolvedValue(emptyList(false));
    renderPage();
    await screen.findByText(/No rubrics yet/i);
    expect(screen.getByRole("button", { name: /New rubric/i })).toBeInTheDocument();
  });
});

describe("Rubrics list — create dialog validation (enabled-CTA regression)", () => {
  it("disables Create until a name is entered, then enables it", async () => {
    apiFetchMock.mockResolvedValue(emptyList(false));
    renderPage();
    await screen.findByText(/No rubrics yet/i);

    fireEvent.click(screen.getByRole("button", { name: /New rubric/i }));

    // Dialog open: the submit button is disabled with an empty name.
    const submit = await screen.findByRole("button", { name: /Create rubric/i });
    expect(submit).toBeDisabled();

    const nameInput = screen.getByLabelText(/Name/i);
    fireEvent.change(nameInput, { target: { value: "My New Rubric" } });

    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it("does not use window.prompt for create", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    apiFetchMock.mockResolvedValue(emptyList(false));
    renderPage();
    await screen.findByText(/No rubrics yet/i);
    fireEvent.click(screen.getByRole("button", { name: /New rubric/i }));
    await screen.findByRole("button", { name: /Create rubric/i });
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
