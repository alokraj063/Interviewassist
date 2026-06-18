// Rubric editor / detail. Tabs: Criteria · Settings · Versions · Calibration ·
// Activity. Dirty tracking + optimistic-concurrency PATCH, publish flow,
// behavioral-anchor authoring, weight summary, preview-as-scorer, archive
// (named confirmation), duplicate, export, AI-suggest (503-gated).
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChevronLeft,
  Copy,
  Download,
  Eye,
  Loader2,
  Plus,
  Sparkles,
  Star,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useCan } from "@/auth/AuthContext";
import {
  APPLIES_TO_OPTIONS,
  criteriaValid,
  normalizedWeights,
  publishable,
  PURPOSE_LABELS,
  useAiSuggest,
  useArchiveRubric,
  useDuplicateRubric,
  usePublishRubric,
  useRestoreRubric,
  useRubric,
  useRubricVersions,
  useSetDefaultRubric,
  useUpdateRubric,
  type RubricAppliesTo,
  type RubricCriterionV2,
  type RubricPurpose,
} from "@/hooks/useRubrics";
import { CriterionRow } from "@/components/rubrics/CriterionRow";
import { WeightSummary } from "@/components/rubrics/WeightSummary";
import { PublishDialog } from "@/components/rubrics/PublishDialog";
import { ArchiveDialog } from "@/components/rubrics/ArchiveDialog";
import { CalibrationPanel } from "@/components/rubrics/CalibrationPanel";
import { AuditTimeline } from "@/components/rubrics/AuditTimeline";

const PURPOSES = Object.keys(PURPOSE_LABELS) as RubricPurpose[];

function newCriterion(): RubricCriterionV2 {
  return {
    id: crypto.randomUUID(),
    name: "New criterion",
    weight: 10,
    kind: "custom",
    bandThresholds: { fail: 40, pass: 65, excellent: 85 },
    anchors: { fail: "", pass: "", excellent: "" },
    minEvidenceQuotes: 0,
    autoScoreEnabled: true,
  };
}

// Mirrors rubricFinalize.ts criteriaBlock so authors preview the scorer prompt.
function previewText(criteria: RubricCriterionV2[], name: string): string {
  const block = criteria
    .map(
      (c) =>
        `- id="${c.id}" name="${c.name}" weight=${c.weight} kind=${c.kind} ` +
        `bands(fail<${c.bandThresholds.fail}, pass>=${c.bandThresholds.pass}, excellent>=${c.bandThresholds.excellent})` +
        (c.description ? `\n  desc: ${c.description}` : "") +
        (c.anchors ? `\n  anchors: fail="${c.anchors.fail ?? ""}" pass="${c.anchors.pass ?? ""}" excellent="${c.anchors.excellent ?? ""}"` : "") +
        (c.minEvidenceQuotes ? `\n  requires ${c.minEvidenceQuotes} evidence quote(s)` : ""),
    )
    .join("\n");
  return `Rubric: ${name}\nCriteria:\n${block}`;
}

export default function RubricEditor() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canWrite = useCan("rubrics.write");
  const readOnly = !canWrite;

  const { data, isLoading, isError, error, refetch } = useRubric(id);
  const versionsQ = useRubricVersions(id);

  const update = useUpdateRubric(id!);
  const publish = usePublishRubric(id!);
  const archive = useArchiveRubric(id!);
  const restore = useRestoreRubric(id!);
  const setDefault = useSetDefaultRubric(id!);
  const duplicate = useDuplicateRubric();
  const aiSuggest = useAiSuggest(id!);

  // ---- local draft ----
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState<RubricPurpose>("general_screen");
  const [appliesTo, setAppliesTo] = useState<RubricAppliesTo[]>(["call"]);
  const [criteria, setCriteria] = useState<RubricCriterionV2[]>([]);
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string>("");

  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [conflict, setConflict] = useState<null | { current: unknown }>(null);

  // Hydrate the local draft from the server snapshot.
  useEffect(() => {
    if (!data) return;
    const r = data.rubric;
    setName(r.name);
    setDescription(r.description ?? "");
    setPurpose(r.purpose);
    setAppliesTo(r.appliesTo.length ? r.appliesTo : ["call"]);
    setCriteria(r.criteria);
    setLoadedUpdatedAt(r.updatedAt);
  }, [data]);

  const dirty = useMemo(() => {
    if (!data) return false;
    const r = data.rubric;
    return (
      name !== r.name ||
      description !== (r.description ?? "") ||
      purpose !== r.purpose ||
      JSON.stringify(appliesTo) !== JSON.stringify(r.appliesTo) ||
      JSON.stringify(criteria) !== JSON.stringify(r.criteria)
    );
  }, [data, name, description, purpose, appliesTo, criteria]);

  const norm = normalizedWeights(criteria);
  const canSave = !readOnly && dirty && criteriaValid(criteria) && !!name.trim();
  const canPublishNow = !readOnly && publishable(criteria) && !dirty;

  if (isLoading) {
    return (
      <div className="p-10 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading rubric…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10 space-y-3">
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Rubric not found or you don't have access."}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
          <Button size="sm" variant="ghost" onClick={() => nav("/rubrics")}>Back to rubrics</Button>
        </div>
      </div>
    );
  }

  const rubric = data.rubric;
  const usage = data.usage;
  const nextVersion = (versionsQ.data?.versions[0]?.version ?? 0) + 1;

  async function save() {
    try {
      const res = await update.mutateAsync({
        name: name.trim(),
        description,
        purpose,
        appliesTo,
        criteria,
        expectedUpdatedAt: loadedUpdatedAt ? new Date(loadedUpdatedAt).toISOString() : undefined,
      });
      setLoadedUpdatedAt(res.rubric.updatedAt);
      toast.success("Saved");
    } catch (err) {
      const e = err as { status?: number; body?: { current?: unknown } };
      if (e.status === 409) {
        setConflict({ current: e.body?.current });
        return;
      }
      toast.error("Save failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  async function doPublish(changeNote: string) {
    try {
      await publish.mutateAsync(changeNote || undefined);
      setPublishOpen(false);
      toast.success(`Published v${nextVersion}`);
      await versionsQ.refetch();
    } catch (err) {
      const e = err as { status?: number; body?: { error?: string } };
      toast.error("Publish failed", { description: e.body?.error ?? (err instanceof Error ? err.message : String(err)) });
    }
  }

  async function doArchive(force: boolean) {
    try {
      await archive.mutateAsync(force);
      setArchiveOpen(false);
      toast.success("Archived");
    } catch (err) {
      toast.error("Archive failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  async function runAiSuggest() {
    try {
      const res = await aiSuggest.mutateAsync({ purpose, context: description });
      setCriteria((prev) => [...prev, ...res.suggestions]);
      toast.success(`Added ${res.suggestions.length} AI-suggested criteria`);
    } catch (err) {
      const e = err as { status?: number; body?: { error?: string } };
      if (e.status === 503 && e.body?.error === "openai_api_key_missing") {
        toast.error("AI suggestions unavailable", { description: "OPENAI_API_KEY is not configured on this server." });
      } else {
        toast.error("AI suggest failed", { description: e.body?.error ?? (err instanceof Error ? err.message : String(err)) });
      }
    }
  }

  function exportRubric() {
    void apiFetch<unknown>(`/api/rubrics/${id}/export`).then((doc) => {
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${rubric.name.replace(/\s+/g, "-").toLowerCase()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function updateCriterion(i: number, next: RubricCriterionV2) {
    setCriteria((prev) => prev.map((c, idx) => (idx === i ? next : c)));
  }
  function removeCriterion(i: number) {
    setCriteria((prev) => prev.filter((_, idx) => idx !== i));
  }
  function moveCriterion(i: number, dir: -1 | 1) {
    setCriteria((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Rubrics", href: "/rubrics" }, { label: rubric.name }]}
        title={
          <span className="flex items-center gap-2">
            <Link to="/rubrics" className="text-muted-foreground hover:text-foreground" aria-label="Back to rubrics">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            {rubric.name}
          </span>
        }
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{PURPOSE_LABELS[rubric.purpose]}</span>
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
                rubric.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"
              }`}
            >
              {rubric.status}
            </span>
            {rubric.publishedVersion && <span className="text-xs text-muted-foreground">Published v{rubric.publishedVersion}</span>}
            {rubric.isDefault && (
              <span className="inline-flex items-center gap-0.5 text-xs text-emerald-600">
                <Star className="w-3 h-3 fill-current" aria-hidden /> Default
              </span>
            )}
            {dirty && (
              <span className="inline-flex items-center rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium text-amber-600">
                Unsaved changes
              </span>
            )}
          </span>
        }
        actions={
          readOnly ? (
            <Badge variant="outline" className="text-muted-foreground">Read-only</Badge>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                <Eye className="w-3.5 h-3.5 mr-1.5" /> Preview
              </Button>
              {rubric.status !== "archived" ? (
                <Button variant="outline" size="sm" onClick={() => setPublishOpen(true)} disabled={!canPublishNow} title={dirty ? "Save changes before publishing" : undefined}>
                  <UploadCloud className="w-3.5 h-3.5 mr-1.5" /> Publish
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void restore.mutateAsync().then(() => toast.success("Restored"))}>
                  Restore
                </Button>
              )}
              <Button size="sm" onClick={() => void save()} disabled={!canSave}>
                {update.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                Save
              </Button>
            </div>
          )
        }
      />

      <div className="p-6">
        <Tabs defaultValue="criteria">
          <TabsList>
            <TabsTrigger value="criteria">Criteria</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="calibration">Calibration</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          {/* ---- Criteria ---- */}
          <TabsContent value="criteria" className="space-y-4 mt-4">
            <Card title="Weighting">
              <div className="p-4">
                <WeightSummary criteria={criteria} />
              </div>
            </Card>
            <Card
              title={`Criteria (${criteria.length})`}
              action={
                !readOnly && (
                  <div className="flex gap-2">
                    {env_has_openai_hint(rubric.purpose) && (
                      <Button size="sm" variant="outline" onClick={() => void runAiSuggest()} disabled={aiSuggest.isPending}>
                        {aiSuggest.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                        AI suggest
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setCriteria((prev) => [...prev, newCriterion()])}>
                      <Plus className="w-3.5 h-3.5 mr-1.5" /> Add criterion
                    </Button>
                  </div>
                )
              }
            >
              {criteria.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  No criteria yet. Add a few — the LLM scorer reads names, weights, bands, and anchors verbatim.
                </div>
              ) : (
                <div className="p-4 space-y-3">
                  {criteria.map((c, i) => (
                    <CriterionRow
                      key={c.id}
                      criterion={c}
                      index={i}
                      total={criteria.length}
                      normalizedPct={norm.get(c.id) ?? 0}
                      readOnly={readOnly}
                      onChange={(next) => updateCriterion(i, next)}
                      onRemove={() => removeCriterion(i)}
                      onMove={(dir) => moveCriterion(i, dir)}
                    />
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>

          {/* ---- Settings ---- */}
          <TabsContent value="settings" className="space-y-4 mt-4">
            <Card title="Details">
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="set-name">Name</Label>
                  <Input id="set-name" value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="set-purpose">Purpose</Label>
                  <Select value={purpose} disabled={readOnly} onValueChange={(v) => setPurpose(v as RubricPurpose)}>
                    <SelectTrigger id="set-purpose"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PURPOSES.map((p) => (
                        <SelectItem key={p} value={p}>{PURPOSE_LABELS[p]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="set-desc">Description</Label>
                  <Textarea id="set-desc" value={description} disabled={readOnly} onChange={(e) => setDescription(e.target.value)} />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>Applies to</Label>
                  <div className="flex flex-wrap gap-3">
                    {APPLIES_TO_OPTIONS.map((opt) => (
                      <label key={opt} className="flex items-center gap-2 text-sm capitalize cursor-pointer">
                        <Checkbox
                          checked={appliesTo.includes(opt)}
                          disabled={readOnly}
                          aria-label={opt}
                          onCheckedChange={() =>
                            setAppliesTo((prev) => (prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]))
                          }
                        />
                        {opt.replace(/_/g, " ")}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            <Card title="Usage">
              <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <UsageChip label="Times scored" value={usage.timesScored} />
                <UsageChip label="Calls scored" value={usage.scoredCalls} />
                <UsageChip label="Voice agents" value={usage.voiceAgents} />
                <UsageChip label="Coaching scenarios" value={usage.coachingScenarios} />
              </div>
            </Card>

            {!readOnly && (
              <Card title="Actions">
                <div className="p-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rubric.status !== "published" || rubric.isDefault || setDefault.isPending}
                    onClick={() => void setDefault.mutateAsync().then(() => toast.success("Set as default")).catch((e) => toast.error("Failed", { description: e instanceof Error ? e.message : String(e) }))}
                  >
                    <Star className="w-3.5 h-3.5 mr-1.5" /> Set as default
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void duplicate.mutateAsync(id!).then((r) => { toast.success("Duplicated"); nav(`/rubrics/${r.rubric.id}`); })}
                  >
                    <Copy className="w-3.5 h-3.5 mr-1.5" /> Duplicate
                  </Button>
                  <Button variant="outline" size="sm" onClick={exportRubric}>
                    <Download className="w-3.5 h-3.5 mr-1.5" /> Export
                  </Button>
                  {rubric.status !== "archived" ? (
                    <Button variant="outline" size="sm" className="text-destructive" onClick={() => setArchiveOpen(true)}>
                      Archive
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => void restore.mutateAsync().then(() => toast.success("Restored"))}>
                      Restore
                    </Button>
                  )}
                </div>
              </Card>
            )}
          </TabsContent>

          {/* ---- Versions ---- */}
          <TabsContent value="versions" className="mt-4">
            <Card title="Published versions">
              {versionsQ.isLoading ? (
                <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading versions…
                </div>
              ) : (versionsQ.data?.versions.length ?? 0) === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No published versions yet. Publish to create an immutable snapshot.</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr><th>Version</th><th>Criteria</th><th>Published by</th><th>When</th><th>Change note</th><th /></tr>
                  </thead>
                  <tbody>
                    {versionsQ.data!.versions.map((v) => (
                      <tr key={v.id}>
                        <td className="font-medium">v{v.version}</td>
                        <td className="tabular-nums">{v.criteria.length}</td>
                        <td className="text-sm">{v.publishedByName ?? "—"}</td>
                        <td className="text-xs text-muted-foreground">{new Date(v.publishedAt).toLocaleString()}</td>
                        <td className="text-xs text-muted-foreground max-w-[280px] truncate">{v.changeNote ?? "—"}</td>
                        <td className="text-right">
                          <Link to={`/rubrics/${id}/versions/${v.version}`} className="text-xs text-primary hover:underline">
                            View frozen snapshot
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </TabsContent>

          {/* ---- Calibration ---- */}
          <TabsContent value="calibration" className="mt-4">
            <Card title="Inter-reviewer calibration">
              <CalibrationPanel rubricId={id!} />
            </Card>
          </TabsContent>

          {/* ---- Activity ---- */}
          <TabsContent value="activity" className="mt-4">
            <Card title="Activity">
              <AuditTimeline rubricId={id!} />
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Scorer preview</DialogTitle>
            <DialogDescription>Exactly what the LLM scorer receives for this rubric.</DialogDescription>
          </DialogHeader>
          <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap">{previewText(criteria, name)}</pre>
        </DialogContent>
      </Dialog>

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        criteria={criteria}
        previousVersion={versionsQ.data?.versions[0]}
        nextVersion={nextVersion}
        submitting={publish.isPending}
        onConfirm={(note) => void doPublish(note)}
      />

      <ArchiveDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        rubricName={rubric.name}
        usage={usage}
        submitting={archive.isPending}
        onConfirm={(force) => void doArchive(force)}
      />

      {/* Conflict dialog */}
      <Dialog open={!!conflict} onOpenChange={(o) => !o && setConflict(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>This rubric changed elsewhere</DialogTitle>
            <DialogDescription>
              Someone else updated this rubric since you loaded it. Reload to get their changes (you'll lose unsaved edits), or overwrite with yours.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConflict(null); void refetch(); }}>Reload theirs</Button>
            <Button
              onClick={async () => {
                setConflict(null);
                try {
                  const res = await update.mutateAsync({ name: name.trim(), description, purpose, appliesTo, criteria });
                  setLoadedUpdatedAt(res.rubric.updatedAt);
                  toast.success("Saved (overwrote)");
                } catch (err) {
                  toast.error("Save failed", { description: err instanceof Error ? err.message : String(err) });
                }
              }}
            >
              Overwrite with mine
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UsageChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// AI-suggest is shown for every purpose; the button itself 503-gates server-side
// so we keep it visible (the toast explains when the key is missing).
function env_has_openai_hint(_purpose: RubricPurpose): boolean {
  return true;
}
