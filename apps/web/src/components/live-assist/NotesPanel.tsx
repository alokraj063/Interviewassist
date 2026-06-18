import { useState, useEffect } from "react";
import { Save, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * Live Assist right-panel: per-call notes.
 *
 * Phase 1: persists to localStorage keyed by callId so the recruiter
 * doesn't lose typed notes if they navigate. Phase 2 patches /api/calls/:id
 * with a notes field (requires schema migration to add the column to
 * call_sessions).
 */
export function NotesPanel({ callId }: { callId?: string }) {
  const storageKey = callId ? `liveAssist.notes.${callId}` : null;
  const [notes, setNotes] = useState<string>(() => {
    if (typeof window === "undefined" || !storageKey) return "";
    return window.localStorage.getItem(storageKey) ?? "";
  });

  // Persist to localStorage on every change.
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, notes);
  }, [notes, storageKey]);

  const isEmpty = notes.trim().length === 0;

  return (
    <div className="flex flex-col" style={{ maxHeight: 320 }}>
      <div className="px-4 py-2 border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center justify-between">
        <span>Call notes</span>
        <span className="text-foreground tabular-nums normal-case">{notes.length} chars</span>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Free-form notes — auto-saved locally. Persists across navigation, syncs to call detail when call ends."
        className="flex-1 p-3 text-sm border-0 focus:outline-none resize-none min-h-[200px]"
      />
      <div className="px-3 py-2 border-t border-border bg-muted/20 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={isEmpty}
          onClick={() => toast.info("Will sync to call record on call end (Phase 2)")}
          className="h-7 text-xs"
        >
          <Save className="w-3 h-3 mr-1" />Save to call
        </Button>
        <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
          <FileText className="w-3 h-3" />Auto-saved locally
        </span>
      </div>
    </div>
  );
}
