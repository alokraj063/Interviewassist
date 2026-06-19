import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { Citation } from "@j2w/shared-types";

// One-shot RAG search — used by the manual "ask KB" field in Live Assist
// and will power the automatic suggestion loop in Phase 7.
export function useKbSearch() {
  return useMutation({
    mutationFn: async (input: { query: string; sourceIds?: string[]; limit?: number }) => {
      const res = await apiFetch<{ hits: Citation[] }>("/api/kb/search", {
        method: "POST",
        json: input,
      });
      return res.hits;
    },
  });
}
