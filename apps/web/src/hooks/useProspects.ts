import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, type ApiError } from "@/lib/api";

export type ProspectStatus =
  | "new"
  | "contacted"
  | "interested"
  | "not_interested"
  | "unreachable"
  | "qualified"
  | "disqualified"
  | "submitted"
  | "parked";

export type DisqualificationReason =
  | "experience_mismatch"
  | "skill_mismatch"
  | "location_mismatch"
  | "compensation_mismatch"
  | "notice_period_mismatch"
  | "not_interested"
  | "unreachable"
  | "duplicate"
  | "other";

export function useUpdateProspectStatus(demandId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ProspectStatus }) => {
      await apiFetch(`/api/prospects/${id}`, { method: "PATCH", json: { status } });
    },
    onSuccess: () => {
      if (demandId) qc.invalidateQueries({ queryKey: ["demands", "prospects", demandId] });
    },
  });
}

export function usePromoteProspect(demandId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ submissionId: string; prospectId: string }, ApiError, string>({
    mutationFn: async (id) => {
      return apiFetch<{ submissionId: string; prospectId: string }>(
        `/api/prospects/${id}/promote-to-submission`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      if (demandId) {
        qc.invalidateQueries({ queryKey: ["demands", "prospects", demandId] });
        qc.invalidateQueries({ queryKey: ["demands", "submissions", demandId] });
      }
    },
  });
}

export function useDisqualifyProspect(demandId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason, notes }: { id: string; reason: DisqualificationReason; notes?: string }) => {
      await apiFetch(`/api/prospects/${id}/disqualify`, { method: "POST", json: { reason, notes } });
    },
    onSuccess: () => {
      if (demandId) qc.invalidateQueries({ queryKey: ["demands", "prospects", demandId] });
    },
  });
}

export function useCreateProspect(demandId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { demandId: string; candidateId: string }) => {
      return apiFetch<{ prospectId: string }>("/api/prospects", {
        method: "POST",
        json: input,
      });
    },
    onSuccess: () => {
      if (demandId) qc.invalidateQueries({ queryKey: ["demands", "prospects", demandId] });
    },
  });
}
