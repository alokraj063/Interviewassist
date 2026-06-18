// Rebalance load: move a demand assignment from this recruiter to another.
// The demand options are the distinct demands this recruiter is actively
// working (derived from the detail payload); the target is any other recruiter
// in the org. The backend validates that the source actually holds an active
// assignment on the chosen demand and 409s otherwise — surfaced inline.
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
import type { ApiError } from "@/lib/api";
import {
  useReassignDemand,
  useRecruiterList,
  type RecruiterDetailResponse,
} from "@/hooks/useRecruiters";

export function ReassignDemandDialog({
  open,
  onOpenChange,
  recruiterId,
  recruiterName,
  detail,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  recruiterId: string;
  recruiterName: string;
  detail: RecruiterDetailResponse | undefined;
}) {
  const [demandId, setDemandId] = useState("");
  const [toRecruiterId, setToRecruiterId] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const reassign = useReassignDemand(recruiterId);
  const recruitersQ = useRecruiterList({ limit: 100, sort: "name", dir: "asc" });

  // Distinct demands the recruiter is working (from prospects + recent calls).
  const demandOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of detail?.activeProspects ?? []) {
      if (p.demandId) map.set(p.demandId, p.demandTitle ?? p.demandId.slice(0, 8));
    }
    for (const c of detail?.recentCalls ?? []) {
      if (c.demandId) map.set(c.demandId, c.demandTitle ?? c.demandId.slice(0, 8));
    }
    return [...map.entries()].map(([id, title]) => ({ id, title }));
  }, [detail]);

  const targetOptions = (recruitersQ.data?.rows ?? []).filter((r) => r.id !== recruiterId);

  useEffect(() => {
    if (!open) return;
    setDemandId("");
    setToRecruiterId("");
    setServerError(null);
  }, [open]);

  const valid = !!demandId && !!toRecruiterId;

  const submit = async () => {
    if (!valid || reassign.isPending) return;
    setServerError(null);
    try {
      await reassign.mutateAsync({ demandId, toRecruiterId });
      toast.success("Demand reassigned");
      onOpenChange(false);
    } catch (err) {
      const e = err as ApiError;
      const body = e.body as { error?: string } | undefined;
      if (body?.error === "assignment_not_found") {
        setServerError("This recruiter no longer holds an active assignment on that demand.");
        return;
      }
      setServerError(body?.error ?? (err instanceof Error ? err.message : "Failed to reassign"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby="reassign-desc">
        <DialogHeader>
          <DialogTitle>Reassign a demand</DialogTitle>
          <DialogDescription id="reassign-desc">
            Move an active assignment off {recruiterName} to rebalance load.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="reassign-demand">Demand</Label>
            {demandOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active demands found for this recruiter to reassign.
              </p>
            ) : (
              <Select value={demandId} onValueChange={setDemandId}>
                <SelectTrigger id="reassign-demand" aria-label="Demand">
                  <SelectValue placeholder="Select a demand" />
                </SelectTrigger>
                <SelectContent>
                  {demandOptions.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reassign-target">Reassign to</Label>
            <Select value={toRecruiterId} onValueChange={setToRecruiterId}>
              <SelectTrigger id="reassign-target" aria-label="Target recruiter">
                <SelectValue placeholder="Select a recruiter" />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name ?? r.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {serverError && (
            <p className="text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={reassign.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || reassign.isPending}>
            {reassign.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {reassign.isPending ? "Reassigning…" : "Reassign demand"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
