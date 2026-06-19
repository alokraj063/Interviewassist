// Configurable leaderboard builder: a weighted-metric list whose weights must
// sum to 1.0 (live-validated), plus fairness guards (min tenure, normalize by
// capacity, exclude on leave). Saves a named view (shared or private). Submit
// is disabled until the name is set and weights sum to 1.0.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  LEADERBOARD_METRICS,
  useSaveLeaderboard,
  type LeaderboardMetric,
  type LeaderboardWeight,
  type Window,
} from "@/hooks/useRecruiters";

const METRIC_LABEL: Record<LeaderboardMetric, string> = {
  submissions: "Submissions",
  client_submits: "Client submits",
  selects: "Selects",
  offers: "Offers",
  joins: "Joins",
  conversion: "Conversion",
  calls: "Calls",
};

export function LeaderboardConfigDialog({
  open,
  onOpenChange,
  window: initialWindow,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  window: Window;
}) {
  const [name, setName] = useState("");
  const [win, setWin] = useState<Window>(initialWindow);
  const [weights, setWeights] = useState<LeaderboardWeight[]>([
    { metric: "submissions", weight: 0.5 },
    { metric: "selects", weight: 0.5 },
  ]);
  const [minTenureDays, setMinTenureDays] = useState("0");
  const [normalizeByCapacity, setNormalizeByCapacity] = useState(true);
  const [excludeOnLeave, setExcludeOnLeave] = useState(true);
  const [isShared, setIsShared] = useState(true);
  const [serverError, setServerError] = useState<string | null>(null);

  const save = useSaveLeaderboard();

  useEffect(() => {
    if (!open) return;
    setName("");
    setWin(initialWindow);
    setWeights([
      { metric: "submissions", weight: 0.5 },
      { metric: "selects", weight: 0.5 },
    ]);
    setMinTenureDays("0");
    setNormalizeByCapacity(true);
    setExcludeOnLeave(true);
    setIsShared(true);
    setServerError(null);
  }, [open, initialWindow]);

  const sum = weights.reduce((s, w) => s + (Number.isFinite(w.weight) ? w.weight : 0), 0);
  const sumValid = Math.abs(sum - 1) < 0.001;
  const valid = name.trim().length > 0 && weights.length >= 1 && sumValid;

  const usedMetrics = new Set(weights.map((w) => w.metric));
  const available = LEADERBOARD_METRICS.filter((m) => !usedMetrics.has(m));

  const addWeight = () => {
    if (available.length === 0 || weights.length >= 7) return;
    setWeights((w) => [...w, { metric: available[0], weight: 0 }]);
  };
  const removeWeight = (i: number) =>
    setWeights((w) => (w.length > 1 ? w.filter((_, idx) => idx !== i) : w));
  const setWeightVal = (i: number, weight: number) =>
    setWeights((w) => w.map((x, idx) => (idx === i ? { ...x, weight } : x)));
  const setWeightMetric = (i: number, metric: LeaderboardMetric) =>
    setWeights((w) => w.map((x, idx) => (idx === i ? { ...x, metric } : x)));

  const submit = async () => {
    if (!valid || save.isPending) return;
    setServerError(null);
    try {
      await save.mutateAsync({
        name: name.trim(),
        isShared,
        config: {
          window: win,
          weights,
          minTenureDays: Number(minTenureDays) || 0,
          normalizeByCapacity,
          excludeOnLeave,
        },
      });
      toast.success("Leaderboard saved");
      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed to save leaderboard");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[88vh] overflow-y-auto" aria-describedby="lb-desc">
        <DialogHeader>
          <DialogTitle>Save leaderboard view</DialogTitle>
          <DialogDescription id="lb-desc">
            Weight the metrics that define rank this period. Weights must sum to 1.0. Fairness guards keep
            new or capacity-heavy recruiters from skewing the board.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="lb-name">Name</Label>
              <Input
                id="lb-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Throughput Q-board"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lb-window">Window</Label>
              <Select value={win} onValueChange={(v) => setWin(v as Window)}>
                <SelectTrigger id="lb-window" aria-label="Window">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7d">Last 7 days</SelectItem>
                  <SelectItem value="30d">Last 30 days</SelectItem>
                  <SelectItem value="90d">Last 90 days</SelectItem>
                  <SelectItem value="qtd">Quarter to date</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Metric weights</Label>
              <span className={cn("text-xs font-medium tabular-nums", sumValid ? "text-success" : "text-destructive")}>
                Sum: {sum.toFixed(2)} {sumValid ? "✓" : "(must be 1.00)"}
              </span>
            </div>
            <div className="space-y-2">
              {weights.map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={w.metric} onValueChange={(v) => setWeightMetric(i, v as LeaderboardMetric)}>
                    <SelectTrigger className="flex-1 h-9" aria-label={`Metric ${i + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEADERBOARD_METRICS.filter((m) => m === w.metric || !usedMetrics.has(m)).map((m) => (
                        <SelectItem key={m} value={m}>
                          {METRIC_LABEL[m]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    step="0.05"
                    min={0}
                    max={1}
                    value={w.weight}
                    onChange={(e) => setWeightVal(i, Number(e.target.value))}
                    className="w-24 h-9"
                    aria-label={`Weight ${i + 1}`}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={weights.length === 1}
                    onClick={() => removeWeight(i)}
                    aria-label={`Remove metric ${i + 1}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addWeight}
              disabled={available.length === 0 || weights.length >= 7}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Add metric
            </Button>
          </div>

          <div className="space-y-2 rounded border border-border p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fairness guards</div>
            <div className="flex items-center justify-between text-sm">
              <Label htmlFor="lb-tenure" className="font-normal">
                Min tenure (days)
              </Label>
              <Input
                id="lb-tenure"
                type="number"
                min={0}
                max={3650}
                value={minTenureDays}
                onChange={(e) => setMinTenureDays(e.target.value)}
                className="w-24 h-8"
              />
            </div>
            <label className="flex items-center justify-between text-sm">
              <span>Normalize by capacity</span>
              <Switch checked={normalizeByCapacity} onCheckedChange={setNormalizeByCapacity} aria-label="Normalize by capacity" />
            </label>
            <label className="flex items-center justify-between text-sm">
              <span>Exclude recruiters on leave</span>
              <Switch checked={excludeOnLeave} onCheckedChange={setExcludeOnLeave} aria-label="Exclude on leave" />
            </label>
          </div>

          <label className="flex items-center justify-between text-sm">
            <span>Share with the whole org</span>
            <Switch checked={isShared} onCheckedChange={setIsShared} aria-label="Share view" />
          </label>

          {serverError && (
            <p className="text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || save.isPending}>
            {save.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {save.isPending ? "Saving…" : "Save view"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
