// Bulk-assign a scenario (or curriculum) to multiple recruiters with a due date.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAssign, useRecruiterOptions } from "@/hooks/useCoaching";

export function AssignDialog({
  open,
  onOpenChange,
  scenarioId,
  curriculumId,
  scenarioTitle,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scenarioId?: string;
  curriculumId?: string;
  scenarioTitle?: string;
}) {
  const recruitersQ = useRecruiterOptions(open);
  const assign = useAssign();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dueAt, setDueAt] = useState("");
  const [minPass, setMinPass] = useState("");

  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setDueAt("");
      setMinPass("");
    }
  }, [open]);

  const recruiters = recruitersQ.data?.rows ?? [];
  const canSubmit = selected.size > 0 && !assign.isPending;

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function onSubmit() {
    if (selected.size === 0) return;
    assign.mutate(
      {
        scenarioId,
        curriculumId,
        assigneeUserIds: [...selected],
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        minPassScore: minPass ? Number(minPass) : undefined,
      },
      {
        onSuccess: (r) => {
          toast.success(`Assigned to ${r.assignments.length} recruiter(s)`);
          onOpenChange(false);
        },
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign practice</DialogTitle>
          <DialogDescription>
            {scenarioTitle ? `“${scenarioTitle}” → recruiters` : "Assign to recruiters"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Recruiters ({selected.size} selected)</Label>
            <ScrollArea className="h-48 rounded-md border border-border">
              {recruitersQ.isLoading ? (
                <p className="p-3 text-sm text-muted-foreground">Loading recruiters…</p>
              ) : recruiters.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No recruiters found.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {recruiters.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-3 py-2">
                      <Checkbox
                        id={`asg-${r.id}`}
                        checked={selected.has(r.id)}
                        onCheckedChange={() => toggle(r.id)}
                      />
                      <Label htmlFor={`asg-${r.id}`} className="flex-1 cursor-pointer font-normal">
                        {r.name ?? r.email}
                        <span className="ml-1 text-xs text-muted-foreground">{r.email}</span>
                      </Label>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="asg-due">Due date</Label>
              <Input id="asg-due" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asg-min">Min pass score</Label>
              <Input
                id="asg-min"
                type="number"
                min={0}
                max={100}
                placeholder="optional"
                value={minPass}
                onChange={(e) => setMinPass(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {assign.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
