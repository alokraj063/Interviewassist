// Scheduled-report authoring: pick a saved view, format, cadence, and a list of
// recipient emails; POST creates the schedule (idempotent server-side). Lists
// existing schedules with enable/disable + delete. Export-permission gated.
import { useState } from "react";
import { CalendarClock, Loader2, Trash2, Plus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useSavedViews,
  useSchedules,
  useCreateSchedule,
  useDeleteSchedule,
  SCHEDULE_CADENCES,
  type ScheduleCadence,
} from "@/hooks/useAnalyticsReports";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ScheduleReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const viewsQ = useSavedViews();
  const schedulesQ = useSchedules();
  const createSchedule = useCreateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const [name, setName] = useState("");
  const [savedViewId, setSavedViewId] = useState("");
  const [cadence, setCadence] = useState<ScheduleCadence>("weekly");
  const [recipientsRaw, setRecipientsRaw] = useState("");

  const recipients = recipientsRaw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const recipientsValid = recipients.length === 0 || recipients.every((r) => EMAIL_RE.test(r));
  const canSubmit = !!name.trim() && !!savedViewId && recipientsValid;

  const views = viewsQ.data?.rows ?? [];
  const schedules = schedulesQ.data?.rows ?? [];

  function submit() {
    if (!canSubmit) return;
    createSchedule.mutate(
      { savedViewId, name: name.trim(), format: "csv", cadence, recipients },
      {
        onSuccess: () => {
          toast.success("Scheduled report created");
          setName("");
          setRecipientsRaw("");
        },
        onError: (e) => toast.error(e.message || "Could not create schedule"),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Scheduled reports</DialogTitle>
          <DialogDescription>
            Deliver a saved view as a CSV on a recurring cadence to a recipient list.
          </DialogDescription>
        </DialogHeader>

        {/* Existing schedules */}
        <div className="space-y-2">
          {schedulesQ.isLoading ? (
            <div className="text-xs text-muted-foreground">Loading schedules…</div>
          ) : schedules.length === 0 ? (
            <div className="text-xs text-muted-foreground">No scheduled reports yet.</div>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {schedules.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.cadence} · {s.format.toUpperCase()} ·{" "}
                      {s.nextRunAt
                        ? `next ${formatDistanceToNow(new Date(s.nextRunAt), { addSuffix: true })}`
                        : "not scheduled"}
                    </div>
                  </div>
                  <button
                    className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted"
                    title="Delete schedule"
                    onClick={() =>
                      deleteSchedule.mutate(s.id, {
                        onSuccess: () => toast.success("Schedule deleted"),
                        onError: (e) => toast.error(e.message),
                      })
                    }
                    data-testid="delete-schedule"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* New schedule form */}
        <div className="space-y-3 border-t border-border pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="sched-name">Name</Label>
            <Input
              id="sched-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly funnel digest"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Saved view</Label>
            <Select value={savedViewId} onValueChange={setSavedViewId}>
              <SelectTrigger aria-label="Saved view">
                <SelectValue placeholder="Select a saved view" />
              </SelectTrigger>
              <SelectContent>
                {views.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    Save a view first to schedule it.
                  </div>
                ) : (
                  views.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Cadence</Label>
            <Select value={cadence} onValueChange={(v) => setCadence(v as ScheduleCadence)}>
              <SelectTrigger aria-label="Cadence">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_CADENCES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sched-recipients">Recipients (comma-separated emails)</Label>
            <Input
              id="sched-recipients"
              value={recipientsRaw}
              onChange={(e) => setRecipientsRaw(e.target.value)}
              placeholder="ops@example.com, lead@example.com"
            />
            {!recipientsValid && (
              <div className="text-xs text-destructive">One or more emails are invalid.</div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit || createSchedule.isPending}
            data-testid="create-schedule"
          >
            {createSchedule.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 h-3.5 w-3.5" />
            )}
            Create schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ScheduleButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={disabled} data-testid="open-schedules">
      <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
      Schedules
    </Button>
  );
}
