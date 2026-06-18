// Assessments list — component tests (Vitest + jsdom).
//
// Covers the four distinct states (loading / first-run-empty / filtered-zero /
// error with inline Retry), permission-gated New-template CTA, and the
// create-dialog disabled-until-valid regression — including the explicit
// assertion that window.prompt is NEVER used for create. apiFetch + useCan are
// mocked; React Router + React Query wrap.
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

let canWrite = true;
let canInvite = true;
vi.mock("@/auth/AuthContext", () => ({
  useCan: (perm: string) => (perm === "assessments.write" ? canWrite : canInvite),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import Assessments from "./Assessments";

function emptyTemplates() {
  return { templates: [], nextCursor: null, total: 0 };
}
function emptyAttempts() {
  return { attempts: [], nextCursor: null, total: 0 };
}

// Route apiFetch by URL so both list hooks (templates + attempts) resolve.
function routeMock(impl: (url: string) => unknown) {
  apiFetchMock.mockImplementation((url: string) => {
    const result = impl(url);
    return result instanceof Promise ? result : Promise.resolve(result);
  });
}

function renderPage(initialEntries = ["/assessments"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Assessments />
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

describe("Assessments list — states", () => {
  it("shows skeletons while loading", () => {
    apiFetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderPage();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("first-run empty (no filters) shows the create-your-first copy", async () => {
    routeMock(() => emptyTemplates());
    renderPage();
    expect(await screen.findByText(/No assessments yet — create your first test/i)).toBeInTheDocument();
  });

  it("filtered-to-zero shows a distinct 'no templates match' copy + Clear filters", async () => {
    routeMock(() => emptyTemplates());
    renderPage(["/assessments?status=draft&q=zzz"]);
    expect(await screen.findByText(/No templates match these filters/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Clear filters/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("error state surfaces the server message + an inline Retry button that refetches", async () => {
    let calls = 0;
    apiFetchMock.mockImplementation(() => {
      calls += 1;
      return Promise.reject(new Error("backend exploded"));
    });
    renderPage();
    expect(await screen.findByText(/backend exploded/i)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /Retry/i });
    const before = calls;
    fireEvent.click(retry);
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });
});

describe("Assessments list — permission gating", () => {
  it("disables the New-template CTA (with reason) for read-only users", async () => {
    canWrite = false;
    routeMock(() => emptyTemplates());
    renderPage();
    await screen.findByText(/No assessments yet/i);
    // The header CTA is rendered disabled with a tooltip reason.
    const buttons = screen.getAllByRole("button", { name: /New template/i });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("enables the New-template CTA for users with assessments.write", async () => {
    canWrite = true;
    routeMock(() => emptyTemplates());
    renderPage();
    await screen.findByText(/No assessments yet/i);
    const headerCta = screen
      .getAllByRole("button", { name: /New template/i })
      .find((b) => !(b as HTMLButtonElement).disabled);
    expect(headerCta).toBeTruthy();
  });
});

describe("Assessments list — attempts tab", () => {
  it("renders the attempts empty state on the attempts tab", async () => {
    routeMock((url) => (url.includes("/attempts") ? emptyAttempts() : emptyTemplates()));
    renderPage(["/assessments?tab=attempts"]);
    expect(await screen.findByText(/No attempts yet/i)).toBeInTheDocument();
  });
});

describe("Assessments list — create dialog validation (enabled-CTA regression)", () => {
  it("disables Create until a title is entered, then enables it", async () => {
    routeMock(() => emptyTemplates());
    renderPage();
    await screen.findByText(/No assessments yet/i);

    // open via the header CTA
    const headerCta = screen
      .getAllByRole("button", { name: /New template/i })
      .find((b) => !(b as HTMLButtonElement).disabled)!;
    fireEvent.click(headerCta);

    const submit = await screen.findByRole("button", { name: /Create assessment/i });
    expect(submit).toBeDisabled();

    const titleInput = screen.getByLabelText(/Title/i);
    fireEvent.change(titleInput, { target: { value: "Java Backend Screen" } });

    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it("never uses window.prompt for create", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    routeMock(() => emptyTemplates());
    renderPage();
    await screen.findByText(/No assessments yet/i);
    const headerCta = screen
      .getAllByRole("button", { name: /New template/i })
      .find((b) => !(b as HTMLButtonElement).disabled)!;
    fireEvent.click(headerCta);
    await screen.findByRole("button", { name: /Create assessment/i });
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
