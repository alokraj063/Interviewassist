import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { Speaker } from "@j2w/shared-types";

export interface CallListItem {
  id: string;
  candidateRefOrPhone: string | null;
  status: "queued" | "assigned" | "active" | "ended";
  origin: string | null;
  mode: string;
  assignedAt: string | null;
  startedAt: string;
  endedAt: string | null;
  recruiterUserId: string | null;
  recruiterName: string | null;
  recruiterEmail: string | null;
}

export function useCalls() {
  return useQuery({
    queryKey: ["calls", "list"],
    queryFn: async () => {
      const res = await apiFetch<{ calls: CallListItem[] }>("/api/calls");
      return res.calls;
    },
  });
}

export interface CallDetail {
  call: {
    id: string;
    orgId: string | null;
    recruiterUserId: string | null;
    candidateRefOrPhone: string | null;
    demandId: string | null;
    prospectId: string | null;
    candidateId: string | null;
    status: "queued" | "assigned" | "active" | "ended";
    origin: string | null;
    mode: string;
    startedAt: string;
    endedAt: string | null;
    summary: { overview?: string; resolution?: string; nextSteps?: string[] } | null;
    recordingUrl: string | null;
    recordingDurationMs: number | null;
    recordingMime: string | null;
  };
  recruiter: { id: string; name: string | null; email: string } | null;
  transcript: Array<{
    id: number;
    callId: string;
    speaker: Speaker;
    text: string;
    isFinal: boolean;
    tsStartMs: number;
    tsEndMs: number;
    sentiment: number | null;
    sentimentModel: string | null;
  }>;
}

export function useCallDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["calls", "detail", id],
    enabled: !!id,
    queryFn: async () => {
      const res = await apiFetch<CallDetail>(`/api/calls/${id}`);
      return res;
    },
    refetchInterval: (query) => {
      const data = query.state.data as CallDetail | undefined;
      if (!data) return false;
      // Poll while live or while summary hasn't been generated yet.
      return data.call.status !== "ended" || !data.call.summary ? 5000 : false;
    },
  });
}
