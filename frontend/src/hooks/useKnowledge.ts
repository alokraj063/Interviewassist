import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiFetch, getApiBase, getStoredToken } from "@/lib/api";
import type { KBDocument, KBIngestEvent, KBSource } from "@j2w/shared-types";

export const KB_CORPORA = ["jd", "company", "question_bank"] as const;
export type KbCorpus = (typeof KB_CORPORA)[number];
export const CORPUS_LABELS: Record<KbCorpus, string> = {
  jd: "JD library",
  company: "Company knowledge",
  question_bank: "Technical question bank",
};

export const SOURCE_STATUSES = ["indexing", "indexed", "error", "deprecated"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export const SOURCE_SORTS = ["created", "updated", "name", "retrievals"] as const;
export type SourceSort = (typeof SOURCE_SORTS)[number];

// ---------- types ----------
export interface KbCollection {
  id: string;
  name: string;
  description: string | null;
  corpus: KbCorpus;
  status: "active" | "deprecated";
  staleAfterDays: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  sourceCount: number;
  docCount: number;
  retrievals7d: number;
}

export interface KbGrant {
  id: string;
  collectionId: string;
  role: string | null;
  userId: string | null;
  level: "read" | "manage";
  createdAt: string | null;
}

export interface KbSourceRow {
  id: string;
  name: string;
  type: KBSource["type"];
  status: SourceStatus;
  collectionId: string | null;
  corpus: KbCorpus | null;
  createdAt: string | null;
  lastIndexedAt: string | null;
  lastRetrievedAt: string | null;
  deprecatedAt: string | null;
  documentCount: number;
  retrievals7d: number;
  staleAfterDays: number | null;
  isStale: boolean;
}

export interface KbEvalSuite {
  id: string;
  name: string;
  corpus: KbCorpus | null;
  createdAt: string | null;
  updatedAt: string | null;
  caseCount: number;
  lastHitRate: number | null;
}

export interface KbEvalRun {
  id: string;
  suiteId: string;
  status: "running" | "completed" | "error";
  caseCount: number;
  hitRate: number | null;
  mrr: number | null;
  citationAccuracy: number | null;
  usedRealEmbeddings: boolean;
  errorMessage: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export interface KbEvalRunCase {
  id: number;
  caseId: string | null;
  query: string;
  hit: boolean;
  rankOfExpected: number | null;
  citationOk: boolean | null;
  topSourceId: string | null;
  topSnippet: string | null;
}

export interface KbFeedback {
  id: string;
  sourceId: string | null;
  collectionId: string | null;
  chunkId: number | null;
  query: string | null;
  rating: "up" | "down";
  reason: string | null;
  comment: string | null;
  status: "open" | "actioned" | "dismissed";
  submittedByUserId: string | null;
  resolvedByUserId: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
}

export interface KbAnalytics {
  days: number;
  totals: {
    retrievals: number;
    zeroResult: number;
    avgLatencyMs: number | null;
    retrievals7d: number;
  };
  byDay: { day: string; retrievals: number; zeroResult: number; avgLatencyMs: number | null }[];
  topSources: { sourceId: string | null; name: string; retrievals: number }[];
  contentGaps: { queryHash: string; misses: number; avgScore: number | null; total: number }[];
  staleness: { stale: number; deprecated: number; total: number };
}

// ---------- collections ----------
export interface SourcesFilters {
  collectionId?: string;
  corpus?: string;
  status?: string;
  staleOnly?: boolean;
  q?: string;
  sort?: SourceSort;
  dir?: "asc" | "desc";
}

export function useKbCollections(filters: { status?: string; corpus?: string; q?: string } = {}) {
  return useQuery({
    queryKey: ["kb", "collections", filters],
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (filters.status) sp.set("status", filters.status);
      if (filters.corpus) sp.set("corpus", filters.corpus);
      if (filters.q) sp.set("q", filters.q);
      sp.set("limit", "100");
      return apiFetch<{ collections: KbCollection[]; nextCursor: string | null; total: number }>(
        `/api/kb/collections?${sp.toString()}`,
      );
    },
  });
}

export function useKbCollection(id: string | undefined) {
  return useQuery({
    queryKey: ["kb", "collection", id],
    enabled: !!id,
    queryFn: async () =>
      apiFetch<{
        collection: KbCollection;
        sources: Pick<KbSourceRow, "id" | "name" | "type" | "status" | "lastIndexedAt" | "lastRetrievedAt">[];
        grants: KbGrant[];
      }>(`/api/kb/collections/${id}`),
  });
}

export function useCreateCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      corpus: KbCorpus;
      description?: string;
      staleAfterDays?: number;
    }) => {
      const res = await apiFetch<{ collection: KbCollection }>("/api/kb/collections", {
        method: "POST",
        json: input,
        headers: { "Idempotency-Key": `col-${crypto.randomUUID()}` },
      });
      return res.collection;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "collections"] }),
  });
}

export function usePatchCollection(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name?: string;
      description?: string | null;
      staleAfterDays?: number | null;
      expectedUpdatedAt?: string;
    }) => {
      const res = await apiFetch<{ collection: KbCollection }>(`/api/kb/collections/${id}`, {
        method: "PATCH",
        json: input,
      });
      return res.collection;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", "collections"] });
      qc.invalidateQueries({ queryKey: ["kb", "collection", id] });
    },
  });
}

export function useSetCollectionStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (next: "deprecate" | "restore") => {
      const res = await apiFetch<{ collection: KbCollection }>(`/api/kb/collections/${id}/${next}`, {
        method: "POST",
        json: {},
      });
      return res.collection;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", "collections"] });
      qc.invalidateQueries({ queryKey: ["kb", "collection", id] });
      qc.invalidateQueries({ queryKey: ["kb", "sources"] });
    },
  });
}

export function useAddGrant(collectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { role?: string; userId?: string; level: "read" | "manage" }) => {
      const res = await apiFetch<{ grant: KbGrant }>(`/api/kb/collections/${collectionId}/grants`, {
        method: "POST",
        json: input,
      });
      return res.grant;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "collection", collectionId] }),
  });
}

export function useRevokeGrant(collectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (grantId: string) => {
      await apiFetch(`/api/kb/collections/${collectionId}/grants/${grantId}`, { method: "DELETE" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "collection", collectionId] }),
  });
}

// ---------- sources ----------
export function useKbSourcesPaged(filters: SourcesFilters, cursor: string | undefined, limit = 25) {
  return useQuery({
    queryKey: ["kb", "sources", "paged", filters, cursor, limit],
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (filters.collectionId) sp.set("collectionId", filters.collectionId);
      if (filters.corpus) sp.set("corpus", filters.corpus);
      if (filters.status) sp.set("status", filters.status);
      if (filters.staleOnly) sp.set("staleOnly", "true");
      if (filters.q) sp.set("q", filters.q);
      if (filters.sort) sp.set("sort", filters.sort);
      if (filters.dir) sp.set("dir", filters.dir);
      sp.set("limit", String(limit));
      if (cursor) sp.set("cursor", cursor);
      return apiFetch<{ sources: KbSourceRow[]; nextCursor: string | null; total: number }>(
        `/api/kb/sources?${sp.toString()}`,
      );
    },
    placeholderData: (prev) => prev,
  });
}

// Legacy unbounded list (kept for backwards-compat consumers like the call surface).
export function useKbSources() {
  return useQuery({
    queryKey: ["kb", "sources"],
    queryFn: async () => {
      const res = await apiFetch<{ sources: KbSourceRow[] }>("/api/kb/sources?limit=100");
      return res.sources;
    },
    refetchInterval: 10_000,
  });
}

export interface KbSourceDetail {
  source: KbSourceRow & { collectionId: string | null };
  documents: (KBDocument & { chunkCount: number; errorMessage: string | null })[];
  chunkPreview: { id: number; corpus: string | null; snippet: string }[];
  feedback: KbFeedback[];
  retrievalSparkline: { day: string; count: number }[];
  audit: { id: number; action: string; entityType: string; detail: unknown; createdAt: string | null }[];
}

export function useKbSource(id: string | undefined) {
  return useQuery({
    queryKey: ["kb", "source", id],
    enabled: !!id,
    queryFn: async () => apiFetch<KbSourceDetail>(`/api/kb/sources/${id}`),
    refetchInterval: 5_000,
  });
}

export function useCreateKbSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; type: KBSource["type"]; collectionId: string }) => {
      const res = await apiFetch<{ source: KbSourceRow }>("/api/kb/sources", {
        method: "POST",
        json: input,
        headers: { "Idempotency-Key": `src-${crypto.randomUUID()}` },
      });
      return res.source;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", "sources"] });
      qc.invalidateQueries({ queryKey: ["kb", "collections"] });
    },
  });
}

export function usePatchSource(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name?: string; collectionId?: string }) => {
      const res = await apiFetch<{ source: KbSourceRow }>(`/api/kb/sources/${id}`, {
        method: "PATCH",
        json: input,
      });
      return res.source;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", "sources"] });
      qc.invalidateQueries({ queryKey: ["kb", "source", id] });
    },
  });
}

export function useReindexSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch<{ reindexed: boolean; docCount?: number; reason?: string }>(
        `/api/kb/sources/${id}/reindex`,
        { method: "POST", json: {} },
      );
      return res;
    },
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["kb", "sources"] });
      qc.invalidateQueries({ queryKey: ["kb", "source", id] });
    },
  });
}

export function useDeprecateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/api/kb/sources/${id}/deprecate`, { method: "POST", json: {} });
    },
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["kb", "sources"] });
      qc.invalidateQueries({ queryKey: ["kb", "source", id] });
    },
  });
}

export function useDeleteKbSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, confirmName }: { id: string; confirmName: string }) => {
      await apiFetch(`/api/kb/sources/${id}`, { method: "DELETE", json: { confirmName } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "sources"] }),
  });
}

export function useBulkSources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      action: "deprecate" | "reindex" | "move";
      ids: string[];
      collectionId?: string;
    }) => {
      return apiFetch<{ updated: number; skipped: string[] }>("/api/kb/sources/bulk", {
        method: "POST",
        json: input,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", "sources"] });
      qc.invalidateQueries({ queryKey: ["kb", "collections"] });
    },
  });
}

export function useUploadDocuments(sourceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files: File[]) => {
      const token = getStoredToken();
      const fd = new FormData();
      for (const file of files) fd.append("files", file, file.name);
      const res = await fetch(`${getApiBase()}/api/kb/sources/${sourceId}/documents`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`upload failed ${res.status}: ${body}`);
      }
      return (await res.json()) as { queued: Array<{ documentId: string; filename: string }> };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb", "sources"] });
      qc.invalidateQueries({ queryKey: ["kb", "source", sourceId] });
    },
  });
}

// ---------- eval ----------
export function useEvalSuites() {
  return useQuery({
    queryKey: ["kb", "eval", "suites"],
    queryFn: async () =>
      apiFetch<{ suites: KbEvalSuite[]; nextCursor: string | null }>("/api/kb/eval/suites?limit=100"),
  });
}

export function useCreateSuite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; corpus?: KbCorpus }) => {
      const res = await apiFetch<{ suite: KbEvalSuite }>("/api/kb/eval/suites", {
        method: "POST",
        json: input,
      });
      return res.suite;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "eval", "suites"] }),
  });
}

export function useAddEvalCase(suiteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      query: string;
      expectedSourceId?: string;
      expectedCollectionId?: string;
      expectedSnippetContains?: string;
    }) => {
      return apiFetch<{ case: { id: string } }>(`/api/kb/eval/suites/${suiteId}/cases`, {
        method: "POST",
        json: input,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "eval", "suites"] }),
  });
}

export function useRunEval(suiteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ run: KbEvalRun }>(`/api/kb/eval/suites/${suiteId}/run`, {
        method: "POST",
        json: {},
        headers: { "Idempotency-Key": `run-${crypto.randomUUID()}` },
      });
      return res.run;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "eval", "suites"] }),
  });
}

export function useEvalRun(runId: string | undefined) {
  return useQuery({
    queryKey: ["kb", "eval", "run", runId],
    enabled: !!runId,
    queryFn: async () =>
      apiFetch<{ run: KbEvalRun; cases: KbEvalRunCase[] }>(`/api/kb/eval/runs/${runId}`),
  });
}

// ---------- feedback ----------
export function useKbFeedback(filters: { status?: string; sourceId?: string } = {}) {
  return useQuery({
    queryKey: ["kb", "feedback", filters],
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (filters.status) sp.set("status", filters.status);
      if (filters.sourceId) sp.set("sourceId", filters.sourceId);
      sp.set("limit", "100");
      return apiFetch<{ feedback: KbFeedback[]; nextCursor: string | null }>(
        `/api/kb/feedback?${sp.toString()}`,
      );
    },
  });
}

export function useSubmitFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sourceId?: string;
      collectionId?: string;
      query?: string;
      rating: "up" | "down";
      reason?: string;
      comment?: string;
    }) => {
      const res = await apiFetch<{ feedback: KbFeedback }>("/api/kb/feedback", {
        method: "POST",
        json: input,
      });
      return res.feedback;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "feedback"] }),
  });
}

export function useResolveFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "actioned" | "dismissed" }) => {
      const res = await apiFetch<{ feedback: KbFeedback }>(`/api/kb/feedback/${id}/resolve`, {
        method: "POST",
        json: { status },
      });
      return res.feedback;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb", "feedback"] }),
  });
}

// ---------- analytics ----------
export function useKbAnalytics(days = 30) {
  return useQuery({
    queryKey: ["kb", "analytics", days],
    queryFn: async () => apiFetch<KbAnalytics>(`/api/kb/analytics?days=${days}`),
  });
}

// ---------- SSE ----------
export function useKbSourceEvents(sourceId: string | undefined, onEvent: (evt: KBIngestEvent) => void) {
  useEffect(() => {
    if (!sourceId) return;
    const token = getStoredToken();
    const url = new URL(`${getApiBase()}/api/kb/sources/${sourceId}/events`);
    if (token) url.searchParams.set("token", token);
    const es = new EventSource(url.toString());
    es.addEventListener("ingest", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as KBIngestEvent;
        onEvent(data);
      } catch {
        // ignore malformed event
      }
    });
    return () => es.close();
  }, [sourceId, onEvent]);
}
