import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateVoiceAgentInput,
  UpdateVoiceAgentInput,
  VapiVoiceOption,
  VoiceAgent,
  VoiceAgentDeployment,
} from "@j2w/shared-types";
import { apiFetch } from "@/lib/api";

const KEYS = {
  all: ["voice-agents"] as const,
  list: () => [...KEYS.all, "list"] as const,
  detail: (id: string) => [...KEYS.all, "detail", id] as const,
  voices: () => [...KEYS.all, "voices"] as const,
  calls: (id: string) => [...KEYS.all, "calls", id] as const,
  stats: (id: string, days: number) => [...KEYS.all, "stats", id, days] as const,
};

export interface VoiceAgentCall {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  status: string;
  customerRef: string | null;
  summary: { overview?: string; resolution?: string } | null;
}

export interface VoiceAgentStats {
  days: number;
  series: Array<{ day: string; calls: number; ended: number; avgDuration: number }>;
  totals: { calls: number; ended: number; resolutionRate: number };
}

export function useVoiceAgentsList() {
  return useQuery({
    queryKey: KEYS.list(),
    queryFn: async () => {
      const res = await apiFetch<{ agents: VoiceAgent[] }>("/api/voice-agents");
      return res.agents;
    },
  });
}

export function useVoiceAgent(id: string | undefined) {
  return useQuery({
    queryKey: KEYS.detail(id ?? ""),
    enabled: !!id,
    queryFn: async () => {
      const res = await apiFetch<{ agent: VoiceAgent; deployments: VoiceAgentDeployment[] }>(
        `/api/voice-agents/${id}`,
      );
      return res;
    },
  });
}

export function useCreateVoiceAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateVoiceAgentInput) => {
      const res = await apiFetch<{ agent: VoiceAgent }>("/api/voice-agents", {
        method: "POST",
        json: input,
      });
      return res.agent;
    },
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
      qc.setQueryData(KEYS.detail(agent.id), { agent, deployments: [] });
    },
  });
}

export function useUpdateVoiceAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UpdateVoiceAgentInput) => {
      const res = await apiFetch<{ agent: VoiceAgent }>(`/api/voice-agents/${id}`, {
        method: "PATCH",
        json: patch,
      });
      return res.agent;
    },
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
      qc.setQueryData<{ agent: VoiceAgent; deployments: VoiceAgentDeployment[] } | undefined>(
        KEYS.detail(id),
        (prev) => (prev ? { ...prev, agent } : { agent, deployments: [] }),
      );
    },
  });
}

export function useDeleteVoiceAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiFetch<{ deleted: string }>(`/api/voice-agents/${id}`, { method: "DELETE" });
      return id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.list() }),
  });
}

export function useDeployVoiceAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ agent: VoiceAgent }>(`/api/voice-agents/${id}/deploy`, {
        method: "POST",
      });
      return res.agent;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.detail(id) });
      qc.invalidateQueries({ queryKey: KEYS.list() });
    },
  });
}

export interface TestCallTicket {
  mode: "inline" | "assistantId";
  publicKey: string;
  assistantId?: string;
  assistant?: Record<string, unknown>;
}

export function useTestCallTicket(id: string) {
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch<TestCallTicket>(`/api/voice-agents/${id}/test-call`, {
        method: "POST",
      });
      return res;
    },
  });
}

export function useVoiceAgentCalls(id: string | undefined, limit = 50) {
  return useQuery({
    queryKey: [...KEYS.calls(id ?? ""), limit],
    enabled: !!id,
    refetchInterval: 10_000,
    queryFn: async () => {
      const res = await apiFetch<{ calls: VoiceAgentCall[] }>(
        `/api/voice-agents/${id}/calls?limit=${limit}`,
      );
      return res.calls;
    },
  });
}

export function useVoiceAgentStats(id: string | undefined, days = 14) {
  return useQuery({
    queryKey: KEYS.stats(id ?? "", days),
    enabled: !!id,
    queryFn: async () => {
      const res = await apiFetch<VoiceAgentStats>(
        `/api/voice-agents/${id}/stats?days=${days}`,
      );
      return res;
    },
  });
}

export function useVapiVoices(enabled = true) {
  return useQuery({
    queryKey: KEYS.voices(),
    enabled,
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const res = await apiFetch<{ voices: VapiVoiceOption[] }>("/api/voice-agents/voices");
      return res.voices;
    },
  });
}
