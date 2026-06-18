import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, getAccessToken, getApiBase, type ApiError } from "@/lib/api";

export interface CandidateListItem {
  id: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  totalExperienceYears: string | null;
  currentCtcLakhs: string | null;
  expectedCtcLakhs: string | null;
  noticePeriodDays: number | null;
  currentLocation: string | null;
  source: string;
  createdAt: string;
}

export interface CandidatesFilters {
  q?: string;
  source?: string;
  skillId?: string;
}

export function useCandidates(filters: CandidatesFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.q) qs.set("q", filters.q);
  if (filters.source) qs.set("source", filters.source);
  if (filters.skillId) qs.set("skillId", filters.skillId);
  const path = qs.size ? `/api/candidates?${qs.toString()}` : "/api/candidates";
  return useQuery({
    queryKey: ["candidates", "list", filters],
    queryFn: async () => {
      const res = await apiFetch<{ candidates: CandidateListItem[] }>(path);
      return res.candidates;
    },
  });
}

export interface CandidateDetail {
  candidate: {
    id: string;
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    displayName: string | null;
    currentTitle: string | null;
    currentCompany: string | null;
    totalExperienceYears: string | null;
    currentCtcLakhs: string | null;
    expectedCtcLakhs: string | null;
    noticePeriodDays: number | null;
    noticePeriodNegotiable: boolean | null;
    currentLocation: string | null;
    preferredLocations: string[];
    linkedinUrl: string | null;
    naukriProfileUrl: string | null;
    githubUrl: string | null;
    summary: string | null;
    source: string;
    createdAt: string;
  };
  skills: Array<{ skillId: string; name: string; proficiencyLevel: number | null; yearsOfExperience: string | null }>;
  experiences: Array<{
    id: string;
    companyName: string;
    title: string | null;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    description: string | null;
  }>;
  qualifications: Array<{
    id: string;
    degree: string | null;
    institution: string | null;
    fieldOfStudy: string | null;
    yearOfCompletion: number | null;
    marksOrGrade: string | null;
  }>;
  submissions: Array<{
    id: string;
    currentStage: string;
    submittedAt: string;
    status: "active" | "withdrawn" | "closed";
    demandId: string;
  }>;
  prospects: Array<{
    id: string;
    status: string;
    demandId: string;
    recruiterId: string;
    createdAt: string;
    lastContactedAt: string | null;
  }>;
  resumes: Array<{
    id: string;
    mime: string | null;
    bytes: number | null;
    originalFilename: string | null;
    modelUsed: string | null;
    createdAt: string;
  }>;
}

export interface ParsedResumeFields {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  totalExperienceYears: number | null;
  currentCtcLakhs: number | null;
  expectedCtcLakhs: number | null;
  noticePeriodDays: number | null;
  currentLocation: string | null;
  summary: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  skills: Array<{ name: string; yearsOfExperience: number | null }>;
  experiences: Array<{
    companyName: string;
    title: string | null;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    description: string | null;
    location: string | null;
  }>;
  qualifications: Array<{
    degree: string | null;
    institution: string | null;
    fieldOfStudy: string | null;
    yearOfCompletion: number | null;
    marksOrGrade: string | null;
  }>;
}

export interface ParsedResumePreview {
  blobKey: string;
  sha256: string;
  bytes: number;
  mime: string;
  filename: string;
  modelUsed: string;
  parsed: ParsedResumeFields;
  parseMeta: { pages?: number; warnings?: string[] };
}

export interface UploadCandidateResumeResult {
  candidateId: string;
  resumeId: string;
  resumeBlobKey: string;
  modelUsed: string;
  parsed: ParsedResumeFields;
  mergedFields: string[];
  addedExperienceCount: number;
  addedQualificationCount: number;
  matchedSkillCount: number;
  unmatchedSkillNames: string[];
}

async function postResumeMultipart<T>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const token = getAccessToken();
  const res = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    body: fd,
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const err = new Error(`HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return (await res.json()) as T;
}

export function useParseResumePreview() {
  return useMutation<ParsedResumePreview, ApiError, File>({
    mutationFn: (file) => postResumeMultipart<ParsedResumePreview>("/api/candidates/parse-resume-preview", file),
  });
}

export function useUploadCandidateResume(candidateId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<UploadCandidateResumeResult, ApiError, File>({
    mutationFn: (file) => {
      if (!candidateId) throw new Error("candidateId is required");
      return postResumeMultipart<UploadCandidateResumeResult>(`/api/candidates/${candidateId}/resume`, file);
    },
    onSuccess: () => {
      if (candidateId) qc.invalidateQueries({ queryKey: ["candidates", "detail", candidateId] });
      qc.invalidateQueries({ queryKey: ["candidates", "list"] });
    },
  });
}

export function useCandidate(id: string | undefined) {
  return useQuery({
    queryKey: ["candidates", "detail", id],
    enabled: !!id,
    queryFn: async () => {
      const res = await apiFetch<CandidateDetail>(`/api/candidates/${id}`);
      return res;
    },
  });
}

export interface DedupMatch {
  id: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  totalExperienceYears: string | null;
  createdAt: string;
  activeSubmissionCount: number;
}

export function useDedupCheck() {
  return useMutation({
    mutationFn: async (input: { email?: string; phone?: string }) => {
      const res = await apiFetch<{ matches: DedupMatch[] }>("/api/candidates/dedup-check", {
        method: "POST",
        json: input,
      });
      return res.matches;
    },
  });
}

export interface CreateCandidateInput {
  email?: string;
  phone?: string;
  firstName: string;
  lastName?: string;
  currentTitle?: string;
  currentCompany?: string;
  totalExperienceYears?: number;
  currentCtcLakhs?: number;
  expectedCtcLakhs?: number;
  noticePeriodDays?: number;
  noticePeriodNegotiable?: boolean;
  currentLocation?: string;
  preferredLocations?: string[];
  linkedinUrl?: string;
  githubUrl?: string;
  summary?: string;
  source?: "naukri" | "linkedin" | "referral" | "direct" | "internal_db" | "imported" | "other";
  skillIds?: string[];
  confirmDuplicate?: boolean;
  // Resume-from-preview attachment (Flow B).
  resumeBlobKey?: string;
  parsedResumeJson?: Record<string, unknown>;
  resumeMeta?: { sha256?: string; bytes?: number; mime?: string; filename?: string; modelUsed?: string };
  experiences?: ParsedResumeFields["experiences"];
  qualifications?: ParsedResumeFields["qualifications"];
  skillNames?: string[];
}

export function useCreateCandidate() {
  const qc = useQueryClient();
  return useMutation<{ candidateId: string }, ApiError, CreateCandidateInput>({
    mutationFn: async (input) => {
      return apiFetch<{ candidateId: string }>("/api/candidates", {
        method: "POST",
        json: input,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["candidates"] }),
  });
}
