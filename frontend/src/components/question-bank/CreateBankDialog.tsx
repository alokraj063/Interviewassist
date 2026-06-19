// Real bank-create form (replaces the old dead placeholder toast).
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  useCreateBank,
  LANGUAGE_LABELS,
  QUESTION_LANGUAGES,
  type QuestionLanguage,
} from "@/hooks/useQuestionBanks";

export function CreateBankDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultLanguage, setDefaultLanguage] = useState<QuestionLanguage>("en");
  const create = useCreateBank();

  const valid = name.trim().length > 0;

  function reset() {
    setName("");
    setDescription("");
    setDefaultLanguage("en");
  }

  function submit() {
    if (!valid || create.isPending) return;
    create.mutate(
      { name: name.trim(), description: description.trim() || null, defaultLanguage },
      {
        onSuccess: (res) => {
          toast.success("Question bank created");
          reset();
          onOpenChange(false);
          onCreated?.(res.id);
        },
        onError: (err: Error) =>
          toast.error(
            (err as { body?: { error?: string } }).body?.error ?? err.message ?? "Create failed",
          ),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New question bank</DialogTitle>
          <DialogDescription>
            Group technical screening questions by skill or role so Live Assist and Assessments can
            draw from a governed corpus.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="bank-name">Name</Label>
            <Input
              id="bank-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Backend — Java / Spring"
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bank-desc">Description</Label>
            <Textarea
              id="bank-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this bank covers and when to use it…"
              maxLength={2000}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bank-lang">Default language</Label>
            <Select
              value={defaultLanguage}
              onValueChange={(v) => setDefaultLanguage(v as QuestionLanguage)}
            >
              <SelectTrigger id="bank-lang">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUESTION_LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LANGUAGE_LABELS[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {create.isPending ? "Creating…" : "Create bank"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
