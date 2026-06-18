// Floating multi-select bar for the question table. Approve is permission-gated
// (question_banks.approve). Set-role / set-language prompt for a value via a
// small inline popover-free input row.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Archive, CheckCircle2, Send, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  useBulkQuestions,
  QUESTION_LANGUAGES,
  LANGUAGE_LABELS,
  type QuestionLanguage,
} from "@/hooks/useQuestionBanks";

export function BulkActionBar({
  bankId,
  selectedIds,
  canApprove,
  onClear,
}: {
  bankId: string;
  selectedIds: string[];
  canApprove: boolean;
  onClear: () => void;
}) {
  const bulk = useBulkQuestions(bankId);
  const [mode, setMode] = useState<"none" | "role" | "language">("none");
  const [roleValue, setRoleValue] = useState("");
  const [langValue, setLangValue] = useState<QuestionLanguage>("en");

  if (selectedIds.length === 0) return null;

  function run(
    action: "archive" | "approve" | "submit_review" | "set_role_family" | "set_language",
    extra?: { roleFamily?: string; language?: QuestionLanguage },
  ) {
    bulk.mutate(
      { questionIds: selectedIds, action, ...extra },
      {
        onSuccess: (res) => {
          toast.success(
            `${res.updated} updated${res.skipped.length ? `, ${res.skipped.length} skipped` : ""}`,
          );
          setMode("none");
          onClear();
        },
        onError: (e: Error) =>
          toast.error((e as { body?: { error?: string } }).body?.error ?? e.message),
      },
    );
  }

  return (
    <div className="sticky bottom-4 z-10 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2 shadow-lg">
      <span className="px-2 text-sm font-medium">{selectedIds.length} selected</span>

      {mode === "none" && (
        <>
          <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => run("archive")}>
            {bulk.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Archive className="mr-1.5 h-3.5 w-3.5" />
            )}
            Archive
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulk.isPending}
            onClick={() => run("submit_review")}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            Submit for review
          </Button>
          {canApprove && (
            <Button
              size="sm"
              variant="outline"
              disabled={bulk.isPending}
              onClick={() => run("approve")}
            >
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              Approve
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setMode("role")}>
            Set role
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("language")}>
            Set language
          </Button>
        </>
      )}

      {mode === "role" && (
        <div className="flex items-center gap-2">
          <Input
            value={roleValue}
            onChange={(e) => setRoleValue(e.target.value)}
            placeholder="Role family…"
            className="h-8 w-40"
            aria-label="Role family"
          />
          <Button
            size="sm"
            disabled={bulk.isPending}
            onClick={() => run("set_role_family", { roleFamily: roleValue.trim() })}
          >
            Apply
          </Button>
        </div>
      )}

      {mode === "language" && (
        <div className="flex items-center gap-2">
          <Select value={langValue} onValueChange={(v) => setLangValue(v as QuestionLanguage)}>
            <SelectTrigger className="h-8 w-36" aria-label="Language">
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
          <Button
            size="sm"
            disabled={bulk.isPending}
            onClick={() => run("set_language", { language: langValue })}
          >
            Apply
          </Button>
        </div>
      )}

      <Button
        size="icon"
        variant="ghost"
        className="ml-auto h-8 w-8"
        aria-label="Clear selection"
        onClick={() => {
          setMode("none");
          onClear();
        }}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
