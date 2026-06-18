// Coaching — component tests (Vitest + jsdom).
//
// Covers list states (loading skeleton / first-run-empty distinct from
// filtered-to-zero / error with inline server message + Retry), permission
// gating (New scenario disabled WITHOUT coaching.write; Team tab hidden WITHOUT
// coaching.read.all), the enabled-CTA regression (primary CTA opens a real form,
// not a toast no-op), and ScenarioForm disabled-until-valid validation.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
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
  useAuth: () => ({ user: { id: "u1", email: "admin@x", name: "Admin", permissions: [] } }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import Coaching from "./Coaching";
import { ScenarioForm } from "@/components/coaching/ScenarioForm";

function scenario(over: Record<string, unknown> = {}) {
  return {
    id: "sc-1",
    title: "Notice-period negotiation",
    description: "Senior backend",
    difficulty: "medium",
    targetRubricId: null,
    targetRubricName: null,
    tags: ["objection"],
    language: "hinglish",
    estimatedMinutes: 8,
    isPublished: true,
    version: 1,
    publishedVersion: 1,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 3,
    avgScore: 72,
    ...over,
  };
}

function renderPage(entry = "/coaching") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Coaching />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  for (const k of Object.keys(can)) delete can[k];
});
afterEach(cleanup);

describe("Coaching page", () => {
  it("renders the loading skeleton, then the scenario list", async () => {
    let resolve!: (v: unknown) => void;
    apiFetchMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { container } = renderPage();
    // skeleton present (animate-pulse from <Skeleton>)
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    resolve({ scenarios: [scenario()], nextCursor: null, total: 1 });
    await waitFor(() => expect(screen.getByText("Notice-period negotiation")).toBeInTheDocument());
    expect(screen.getByText(/Showing 1 of 1/)).toBeInTheDocument();
  });

  it("first-run empty shows the authoring CTA (distinct from filtered-to-zero)", async () => {
    can["coaching.write"] = true;
    apiFetchMock.mockResolvedValue({ scenarios: [], nextCursor: null, total: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No coaching scenarios yet/)).toBeInTheDocument());
    // CTA in the empty state is the real authoring action, not a toast.
    expect(screen.getAllByRole("button", { name: /New scenario/ }).length).toBeGreaterThan(0);
  });

  it("filtered-to-zero shows a distinct Clear-all message", async () => {
    apiFetchMock.mockResolvedValue({ scenarios: [], nextCursor: null, total: 0 });
    renderPage("/coaching?difficulty=hard");
    await waitFor(() => expect(screen.getByText(/No scenarios match these filters/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Clear all filters/ })).toBeInTheDocument();
  });

  it("error state surfaces the server message and a Retry button", async () => {
    apiFetchMock.mockRejectedValue({ body: { error: "boom_from_server" } });
    renderPage();
    await waitFor(() => expect(screen.getByText("boom_from_server")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("New scenario CTA is enabled WITH coaching.write (not a no-op toast)", async () => {
    can["coaching.write"] = true;
    apiFetchMock.mockResolvedValue({ scenarios: [scenario()], nextCursor: null, total: 1 });
    renderPage();
    const cta = screen.getByRole("button", { name: /New scenario/ });
    expect(cta).not.toBeDisabled();
    fireEvent.click(cta);
    // A real dialog opens with the authoring fields.
    await waitFor(() => expect(screen.getByLabelText("Title")).toBeInTheDocument());
  });

  it("New scenario CTA is disabled WITHOUT coaching.write", async () => {
    apiFetchMock.mockResolvedValue({ scenarios: [scenario()], nextCursor: null, total: 1 });
    renderPage();
    await waitFor(() => expect(screen.getByText("Notice-period negotiation")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /New scenario/ })).toBeDisabled();
  });

  it("hides the Team tab without coaching.read.all", async () => {
    apiFetchMock.mockResolvedValue({ scenarios: [], nextCursor: null, total: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No coaching scenarios/)).toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: "Team" })).toBeNull();
  });

  it("shows the Team tab with coaching.read.all", async () => {
    can["coaching.read.all"] = true;
    apiFetchMock.mockResolvedValue({ scenarios: [], nextCursor: null, total: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Team" })).toBeInTheDocument());
  });
});

describe("ScenarioForm validation", () => {
  function renderForm() {
    can["coaching.write"] = true;
    // rubric options fetch
    apiFetchMock.mockResolvedValue({ rubrics: [] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScenarioForm open onOpenChange={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("disables submit until the title is valid, then enables it", async () => {
    renderForm();
    const submit = await screen.findByRole("button", { name: /Create scenario/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "My new scenario" },
    });
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it("rejects out-of-range estimated minutes", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "ok" } });
    fireEvent.change(screen.getByLabelText("Est. minutes"), { target: { value: "999" } });
    expect(await screen.findByText(/Minutes must be 1–120/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create scenario/ })).toBeDisabled();
  });
});
