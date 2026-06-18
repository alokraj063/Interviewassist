import { useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ChevronLeft,
  Plus,
  Loader2,
  AlertTriangle,
  Eye,
  Lock,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import { ItemEditor } from "@/components/assessments/ItemEditor";
import { SectionList } from "@/components/assessments/SectionList";
import { ProctoringPolicyForm } from "@/components/assessments/ProctoringPolicyForm";
import { PassBandsEditor } from "@/components/assessments/PassBandsEditor";
import { PreviewDialog } from "@/components/assessments/PreviewDialog";
import {
  useTemplateDetail,
  useCreateItem,
  useUpdateItem,
  useDeleteItem,
  useReorderItems,
  useCreateSection,
  useDeleteSection,
  useUpdateTemplate,
  usePublishTemplate,
  useUnpublishTemplate,
  type Item,
  type ItemType,
  type PassBand,
  type ProctoringPolicy,
  type Section,
} from "@/hooks/useAssessments";

export default function AssessmentBuilder() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canWrite = useCan("assessments.write");
  const { data, isLoading, isError, error, refetch } = useTemplateDetail(id);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [defaultType, setDefaultType] = useState<ItemType>("mcq_single");
  const [sectionOpen, setSectionOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const createItem = useCreateItem(id ?? "");
  const updateItem = useUpdateItem(id ?? "");
  const deleteItem = useDeleteItem(id ?? "");
  const reorder = useReorderItems(id ?? "");
  const deleteSection = useDeleteSection(id ?? "");
  const publish = usePublishTemplate(id ?? "");
  const unpublish = useUnpublishTemplate(id ?? "");

  const template = data?.template;
  const published = template?.status === "published";
  const items = data?.items ?? [];
  const sections = data?.sections ?? [];

  const gradableCount = useMemo(
    () => items.filter((it) => ["mcq_single", "mcq_multi", "true_false", "coding"].includes(it.type)).length,
    [items],
  );

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError || !template) {
    return (
      <div className="p-10 flex flex-col items-center gap-3 text-sm">
        <AlertTriangle className="w-7 h-7 text-destructive" />
        <div className="text-destructive">
          {(error as { body?: { error?: string } })?.body?.error ?? "Template not found."}
        </div>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const saveItem = async (payload: {
    type: ItemType;
    prompt: string;
    points: number;
    negativePoints: number;
    partialCredit: boolean;
    required: boolean;
    timeLimitSeconds: number | null;
    config: Record<string, unknown>;
  }) => {
    try {
      if (editing) {
        await updateItem.mutateAsync({ itemId: editing.id, body: payload });
        toast.success("Question updated");
      } else {
        await createItem.mutateAsync(payload);
        toast.success("Question added");
      }
      setEditorOpen(false);
      setEditing(null);
    } catch (err) {
      toast.error("Couldn't save question", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onMoveItem = async (item: Item, dir: -1 | 1) => {
    const group = items
      .filter((it) => it.sectionId === item.sectionId)
      .sort((a, b) => a.position - b.position);
    const idx = group.findIndex((it) => it.id === item.id);
    const swap = group[idx + dir];
    if (!swap) return;
    try {
      await reorder.mutateAsync([
        { itemId: item.id, sectionId: item.sectionId, position: swap.position },
        { itemId: swap.id, sectionId: swap.sectionId, position: item.position },
      ]);
    } catch (err) {
      toast.error("Couldn't reorder", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const onPublish = async () => {
    try {
      const res = await publish.mutateAsync();
      toast.success(`Published v${res.version}`);
    } catch (err) {
      const body = (err as { body?: { error?: string; message?: string } })?.body;
      toast.error("Couldn't publish", { description: body?.message ?? body?.error ?? (err instanceof Error ? err.message : String(err)) });
    }
  };

  const onUnpublish = async () => {
    try {
      await unpublish.mutateAsync();
      toast.success("Unpublished — now editable as a draft");
    } catch (err) {
      toast.error("Couldn't unpublish", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to={`/assessments/${id}`} className="text-muted-foreground hover:text-foreground" aria-label="Back to overview">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            Build · {template.title}
          </span>
        }
        subtitle={
          published
            ? `Published v${template.publishedVersion}. Editing structure is locked — unpublish or duplicate to make changes.`
            : "Add sections and typed questions, set scoring + anti-cheat, then publish to lock an immutable version."
        }
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
              <Eye className="w-3.5 h-3.5 mr-1.5" /> Preview
            </Button>
            {canWrite &&
              (published ? (
                <Button variant="outline" size="sm" onClick={() => void onUnpublish()} disabled={unpublish.isPending}>
                  {unpublish.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Lock className="w-3.5 h-3.5 mr-1.5" />}
                  Unpublish
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => void onPublish()}
                  disabled={publish.isPending || items.length === 0 || gradableCount === 0}
                  title={items.length === 0 ? "Add at least one item" : gradableCount === 0 ? "Add at least one gradable item" : undefined}
                >
                  {publish.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
                  Publish
                </Button>
              ))}
          </div>
        }
      />

      <div className="p-6 grid grid-cols-12 gap-4">
        {/* questions */}
        <div className="col-span-8 space-y-4">
          <Card
            title="Questions & sections"
            action={
              canWrite && !published ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setSectionOpen(true)}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Section
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing(null);
                      setDefaultType("mcq_single");
                      setEditorOpen(true);
                    }}
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" /> Question
                  </Button>
                </div>
              ) : undefined
            }
          >
            <div className="p-4">
              <SectionList
                sections={sections}
                items={items}
                disabled={!canWrite || published}
                onEditItem={(it) => {
                  setEditing(it);
                  setDefaultType(it.type);
                  setEditorOpen(true);
                }}
                onDeleteItem={(it) => {
                  void deleteItem.mutateAsync(it.id).then(() => toast.success("Question removed"));
                }}
                onMoveItem={onMoveItem}
                onDeleteSection={(s) => {
                  void deleteSection.mutateAsync(s.id).then(() => toast.success("Section removed"));
                }}
              />
            </div>
          </Card>
        </div>

        {/* settings */}
        <div className="col-span-4 space-y-4">
          <ScoringCard templateId={id!} passScore={template.passScore} bands={template.settings?.passBands ?? []} disabled={!canWrite} />
          <Card title="Anti-cheat policy">
            <div className="p-4">
              <PolicyCard templateId={id!} policy={template.proctoringPolicy ?? {}} disabled={!canWrite} />
            </div>
          </Card>
          <div className="text-xs text-muted-foreground px-1">
            {gradableCount} auto-gradable · {items.length} total items
          </div>
        </div>
      </div>

      {/* item editor dialog */}
      <Dialog open={editorOpen} onOpenChange={(v) => { setEditorOpen(v); if (!v) setEditing(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit question" : "Add question"}</DialogTitle>
            <DialogDescription>Choose a type, write the prompt, and set scoring.</DialogDescription>
          </DialogHeader>
          <ItemEditor
            item={editing}
            defaultType={defaultType}
            codeExecConfigured={false}
            saving={createItem.isPending || updateItem.isPending}
            onSave={saveItem}
            onCancel={() => { setEditorOpen(false); setEditing(null); }}
          />
        </DialogContent>
      </Dialog>

      <SectionDialog
        open={sectionOpen}
        onOpenChange={setSectionOpen}
        templateId={id!}
        onCreated={() => { setSectionOpen(false); void nav(`/assessments/${id}/build`); }}
      />

      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} templateId={id!} />
    </div>
  );
}

function ScoringCard({
  templateId,
  passScore,
  bands,
  disabled,
}: {
  templateId: string;
  passScore: number;
  bands: PassBand[];
  disabled: boolean;
}) {
  const update = useUpdateTemplate(templateId);
  const [pass, setPass] = useState(String(passScore));
  const [localBands, setLocalBands] = useState<PassBand[]>(bands);
  const dirty = Number(pass) !== passScore || JSON.stringify(localBands) !== JSON.stringify(bands);

  const save = async () => {
    try {
      await update.mutateAsync({ passScore: Number(pass), settings: { passBands: localBands.filter((b) => b.label.trim()) } });
      toast.success("Scoring saved");
    } catch (err) {
      toast.error("Couldn't save scoring", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Card title="Scoring">
      <div className="p-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="pass-score">Pass score (%)</Label>
          <Input
            id="pass-score"
            type="number"
            min={0}
            max={100}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            disabled={disabled}
            className="w-28"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Pass bands</Label>
          <PassBandsEditor bands={localBands} onChange={setLocalBands} disabled={disabled} />
        </div>
        {!disabled && (
          <Button size="sm" onClick={() => void save()} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
            Save scoring
          </Button>
        )}
      </div>
    </Card>
  );
}

function PolicyCard({
  templateId,
  policy,
  disabled,
}: {
  templateId: string;
  policy: ProctoringPolicy;
  disabled: boolean;
}) {
  const update = useUpdateTemplate(templateId);
  const [local, setLocal] = useState<ProctoringPolicy>(policy);
  const dirty = JSON.stringify(local) !== JSON.stringify(policy);
  return (
    <div className="space-y-3">
      <ProctoringPolicyForm policy={local} onChange={setLocal} disabled={disabled} />
      {!disabled && dirty && (
        <Button
          size="sm"
          onClick={() => {
            void update
              .mutateAsync({ proctoringPolicy: { enabled: local.enabled ?? false, ...local } })
              .then(() => toast.success("Policy saved"))
              .catch((err) => toast.error("Couldn't save policy", { description: err instanceof Error ? err.message : String(err) }));
          }}
          disabled={update.isPending}
        >
          {update.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          Save policy
        </Button>
      )}
    </div>
  );
}

function SectionDialog({
  open,
  onOpenChange,
  templateId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  templateId: string;
  onCreated: (s: Section) => void;
}) {
  const create = useCreateSection(templateId);
  const [title, setTitle] = useState("");
  const [timeMin, setTimeMin] = useState("");
  const [shuffle, setShuffle] = useState("no");

  const submit = async () => {
    if (!title.trim()) return;
    try {
      const res = await create.mutateAsync({
        title: title.trim(),
        timeLimitSeconds: timeMin ? Number(timeMin) * 60 : null,
        shuffleItems: shuffle === "yes",
      });
      toast.success("Section added");
      setTitle("");
      setTimeMin("");
      onCreated(res.section);
    } catch (err) {
      toast.error("Couldn't add section", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New section</DialogTitle>
          <DialogDescription>Group questions with optional per-section timing + shuffle.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="sec-title">Title</Label>
            <Input id="sec-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Core concepts" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sec-time">Time limit (min, optional)</Label>
              <Input id="sec-time" type="number" min={1} value={timeMin} onChange={(e) => setTimeMin(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Shuffle items</Label>
              <Select value={shuffle} onValueChange={setShuffle}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no">No</SelectItem>
                  <SelectItem value="yes">Yes</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!title.trim() || create.isPending}>
            {create.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
            Add section
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
