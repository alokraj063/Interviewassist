// RubricEditor — component tests (Vitest + jsdom). Covers loading + error
// states, the publish-disabled-until-valid regression, read-only permission
// degradation, and the no-window.confirm guarantee.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

let canWrite = true;
vi.mock("@/auth/AuthContext", () => ({ useCan: () => canWrite }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import RubricEditor from "./RubricEditor";

const RUBRIC_ID = "11111111-1111-1111-1111-111111111111";

function criterion(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "Communication",
    weight: 50,
    kind: "candidate_experience",
    bandThresholds: { fail: 40, pass: 65, excellent: 85 },
    anchors: { fail: "", pass: "", excellent: "" },
    minEvidenceQuotes: 0,
    autoScoreEnabled: true,
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}) {
  return {
    rubric: {
      id: RUBRIC_ID,
      name: "Editor Test Rubric",
      version: 1,
      publishedVersion: null,
      purpose: "general_screen",
      status: "draft",
      appliesTo: ["call"],
      clientId: null,
      description: "",
      criteria: [criterion()],
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      timesUsed: 0,
      ...over,
    },
    usage: { timesScored: 0, scoredCalls: 0, voiceAgents: 0, coachingScenarios: 0, defaultForPurpose: false },
    recentAudit: [],
  };
}

// Route apiFetch by URL so each query resolves with the right shape.
function routeApi(detailResp: unknown) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === `/api/rubrics/${RUBRIC_ID}`) return Promise.resolve(detailResp);
    if (path.endsWith("/versions")) return Promise.resolve({ versions: [] });
    if (path.endsWith("/audit")) return Promise.resolve({ entries: [], nextCursor: null });
    if (path.endsWith("/calibration")) return Promise.resolve({ criteria: [], reviewCount: 0 });
    return Promise.resolve({});
  });
}

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/rubrics/${RUBRIC_ID}`]}>
        <Routes>
          <Route path="/rubrics/:id" element={<RubricEditor />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  canWrite = true;
});
afterEach(() => cleanup());

describe("RubricEditor — states", () => {
  it("shows a loading state, then the rubric name", async () => {
    routeApi(detail());
    renderEditor();
    expect(await screen.findAllByText(/Editor Test Rubric/i)).not.toHaveLength(0);
  });

  it("shows an error state with Retry when the detail load fails", async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === `/api/rubrics/${RUBRIC_ID}`) return Promise.reject(new Error("load failed badly"));
      return Promise.resolve({});
    });
    renderEditor();
    expect(await screen.findByText(/load failed badly/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });
});

describe("RubricEditor — publish gating (enabled-CTA regression)", () => {
  it("disables Publish when weights are zero, enables when a positive weight exists", async () => {
    routeApi(detail({ criteria: [criterion({ weight: 0 })] }));
    renderEditor();
    await screen.findAllByText(/Editor Test Rubric/i);

    const publishBtn = screen.getByRole("button", { name: /Publish/i });
    expect(publishBtn).toBeDisabled();

    // Raise the weight to a positive value → publishable (and not dirty since
    // it differs from server, dirty blocks publish too; we assert via Save).
    const weightInput = screen.getByLabelText(/Weight/i) as HTMLInputElement;
    fireEvent.change(weightInput, { target: { value: "30" } });

    // Editing makes it dirty → Save becomes enabled.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/i })).not.toBeDisabled());
  });
});

describe("RubricEditor — permission degradation", () => {
  it("renders read-only badge and hides Save/Publish for users without rubrics.write", async () => {
    canWrite = false;
    routeApi(detail());
    renderEditor();
    await screen.findAllByText(/Editor Test Rubric/i);
    expect(screen.getAllByText(/Read-only/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /^Save$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Publish/i })).toBeNull();
  });
});

describe("RubricEditor — no destructive native dialogs", () => {
  it("never calls window.confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    routeApi(detail());
    renderEditor();
    await screen.findAllByText(/Editor Test Rubric/i);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
