import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { mockIdToUuid } from "@/lib/mockCallIds";

export type ResolutionVerdict = "supported" | "contradicted" | "unsupported" | "not_applicable";

export interface ResolutionClaim {
  id: string;
  text: string;
  verdict: ResolutionVerdict;
  gap: string;
  evidenceTs?: string;
  evidenceQuote?: string;
  kbSource?: string;
}

export interface ResolutionAnalysis {
  callId: string;
  agentResolution: string;
  kbAnswer: string;
  claims: ResolutionClaim[];
  overallSeverity: "low" | "medium" | "high" | "critical";
  computedAt: string;
  modelVersion: string;
}

interface Envelope {
  analysis: ResolutionAnalysis;
  cached: boolean;
}

export function useResolutionAnalysis(mockCallId: string | undefined) {
  const uuid = mockCallId ? mockIdToUuid(mockCallId) : undefined;
  return useQuery({
    queryKey: ["qa-resolution", uuid],
    queryFn: () => apiFetch<Envelope>(`/api/qa/${uuid}/resolution`),
    enabled: !!uuid,
    // First compute takes 4-8s server-side; after that the cached payload
    // returns in <100ms. Don't retry on 404 (call not in DB yet — dev seeder
    // may not have run). Do not refetch on window focus; the payload is
    // stable until the user hits Recompute.
    retry: (failureCount, error) => {
      const status = (error as { status?: number })?.status ?? 0;
      if (status === 404 || status === 400) return false;
      return failureCount < 1;
    },
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });
}

export function useRecomputeResolution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mockCallId: string) => {
      const uuid = mockIdToUuid(mockCallId);
      return apiFetch<Envelope>(`/api/qa/${uuid}/resolution/recompute`, { method: "POST" });
    },
    onSuccess: (data, mockCallId) => {
      qc.setQueryData(["qa-resolution", mockIdToUuid(mockCallId)], data);
    },
  });
}
