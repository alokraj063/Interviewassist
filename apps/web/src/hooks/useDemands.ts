import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface DemandListItem {
  id: string;
  title: string;
  designation: string | null;
  status: "draft" | "active" | "on_hold" | "closed" | "cancelled";
  isVip: boolean;
  primaryLocation: string | null;
  salaryFrom: string | null;
  salaryTo: string | null;
  experienceMinYears: string | null;
  experienceMaxYears: string | null;
  numberOfOpenings: number;
  maxSubmissions: number | null;
  expectedClosureDate: string | null;
  clientId: string;
  clientName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemandFilters {
  status?: DemandListItem["status"];
  clientId?: string;
  isVip?: boolean;
  assignedToMe?: boolean;
  q?: string;
}

export function useDemands(filters: DemandFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.status) qs.set("status", filters.status);
  if (filters.clientId) qs.set("clientId", filters.clientId);
  if (filters.isVip != null) qs.set("isVip", String(filters.isVip));
  if (filters.assignedToMe != null) qs.set("assignedToMe", String(filters.assignedToMe));
  if (filters.q) qs.set("q", filters.q);
  const path = qs.size ? `/api/demands?${qs.toString()}` : "/api/demands";
  return useQuery({
    queryKey: ["demands", "list", filters],
    queryFn: async () => {
      const res = await apiFetch<{ demands: DemandListItem[] }>(path);
      return res.demands;
    },
  });
}

export interface DemandSkillRow {
  skillId: string;
  name: string;
  isMandatory: boolean;
  weight: string;
}

export interface DemandLocationRow {
  locationId: string;
  city: string;
  state: string | null;
}

export interface DemandAssignmentRow {
  recruiterId: string;
  recruiterName: string | null;
  recruiterEmail: string;
  assignedAt: string;
  status: "active" | "released";
}

export interface DemandDetail {
  demand: {
    id: string;
    title: string;
    designation: string | null;
    description: string | null;
    responsibilities: string | null;
    status: DemandListItem["status"];
    isVip: boolean;
    salaryFrom: string | null;
    salaryTo: string | null;
    experienceMinYears: string | null;
    experienceMaxYears: string | null;
    numberOfOpenings: number;
    maxSubmissions: number | null;
    primaryLocation: string | null;
    clientInternalTicketId: string | null;
    expectedClosureDate: string | null;
    requestedDate: string | null;
    requestedBy: string | null;
    groupName: string | null;
    subGroupName: string | null;
    probingDetails: Record<string, unknown> | null;
    mandatoryChecks: string[];
    clientId: string;
    industryId: string | null;
    jobRoleId: string | null;
    metadata: Record<string, unknown> | null;
    externalOfferLetterDemandId: number | null;
    createdAt: string;
    updatedAt: string;
  };
  clientName: string | null;
  industryName: string | null;
  jobRoleName: string | null;
  skills: DemandSkillRow[];
  locations: DemandLocationRow[];
  assignments: DemandAssignmentRow[];
}

export function useDemand(id: string | undefined) {
  return useQuery({
    queryKey: ["demands", "detail", id],
    enabled: !!id,
    queryFn: async () => {
      const res = await apiFetch<DemandDetail>(`/api/demands/${id}`);
      return res;
    },
  });
}

export interface DemandProspectRow {
  id: string;
  status: string;
  interestLevel: number | null;
  notes: string | null;
  lastContactedAt: string | null;
  createdAt: string;
  candidateId: string;
  candidateName: string | null;
  candidateEmail: string | null;
  candidatePhone: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  recruiterId: string;
  recruiterName: string | null;
  recruiterEmail: string;
}

export function useDemandProspects(demandId: string | undefined) {
  return useQuery({
    queryKey: ["demands", "prospects", demandId],
    enabled: !!demandId,
    queryFn: async () => {
      const res = await apiFetch<{ prospects: DemandProspectRow[] }>(`/api/demands/${demandId}/prospects`);
      return res.prospects;
    },
  });
}

export interface DemandSubmissionRow {
  id: string;
  currentStage: string;
  previousStage: string | null;
  submittedAt: string;
  status: "active" | "withdrawn" | "closed";
  candidateId: string;
  candidateName: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  recruiterId: string | null;
  recruiterName: string | null;
}

export function useDemandSubmissions(demandId: string | undefined) {
  return useQuery({
    queryKey: ["demands", "submissions", demandId],
    enabled: !!demandId,
    queryFn: async () => {
      const res = await apiFetch<{ submissions: DemandSubmissionRow[] }>(`/api/demands/${demandId}/submissions`);
      return res.submissions;
    },
  });
}

export function useAssignRecruiters(demandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (recruiterIds: string[]) => {
      await apiFetch(`/api/demands/${demandId}/assignments`, {
        method: "POST",
        json: { recruiterIds },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["demands", "detail", demandId] }),
  });
}

export function useReleaseRecruiter(demandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (recruiterId: string) => {
      await apiFetch(`/api/demands/${demandId}/assignments/${recruiterId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["demands", "detail", demandId] }),
  });
}
