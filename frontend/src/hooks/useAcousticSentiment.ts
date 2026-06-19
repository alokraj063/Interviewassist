import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { mockIdToUuid } from "@/lib/mockCallIds";

export interface AcousticWindow {
  speaker: "agent" | "customer";
  tsStartMs: number;
  tsEndMs: number;
  valence: number; // [-1, 1]
  arousal: number; // [0, 1]
  f0Mean: number | null;
  rmsEnergy: number | null;
  modelVersion: string;
}

export interface AcousticResponse {
  windows: AcousticWindow[];
  recordingUrl: string | null;
  recordingDurationMs: number | null;
}

/**
 * Returns the acoustic-sentiment timeline for a call, or null if the user
 * doesn't have `qa.acoustic` permission or the Phase 2 worker hasn't written
 * any windows yet. Callers treat both cases as "fall back to text-only".
 */
export function useAcousticSentiment(mockCallId: string | undefined, enabled = true) {
  const uuid = mockCallId ? mockIdToUuid(mockCallId) : undefined;
  return useQuery<AcousticResponse>({
    queryKey: ["qa-acoustic", uuid],
    queryFn: () => apiFetch<AcousticResponse>(`/api/qa/${uuid}/acoustic`),
    enabled: !!uuid && enabled,
    // 403 means the user doesn't have qa.acoustic; 404 means call not in DB.
    // Neither should spam retries.
    retry: (failureCount, error) => {
      const status = (error as { status?: number })?.status ?? 0;
      if (status === 403 || status === 404) return false;
      return failureCount < 1;
    },
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });
}

export function useRecomputeAcoustic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mockCallId: string) => {
      const uuid = mockIdToUuid(mockCallId);
      return apiFetch<{ queued: boolean }>(`/api/qa/${uuid}/acoustic/recompute`, { method: "POST" });
    },
    onSuccess: (_data, mockCallId) => {
      // Worker usually finishes in a few seconds; invalidate so the next
      // view reads fresh windows.
      qc.invalidateQueries({ queryKey: ["qa-acoustic", mockIdToUuid(mockCallId)] });
    },
  });
}
