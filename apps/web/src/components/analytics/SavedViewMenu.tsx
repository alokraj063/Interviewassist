// Saved-view authoring: a dropdown to load a saved view (writes its config into
// the URL filters), plus a "Save view" dialog (name + description + share
// toggle) and archive-with-confirmation. Real form UX, not a browser dialog.
import { useState } from "react";
import { BookMarked, Plus, Loader2, Archive, Share2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useSavedViews,
  useCreateView,
  useArchiveView,
  type SavedView,
  type AnalyticsFilters,
} from "@/hooks/useAnalyticsReports";

export function SavedViewMenu({
  filters,
  tab,
  onLoad,
}: {
  filters: AnalyticsFilters;
  tab: string;
  onLoad: (view: SavedView) => void;
}) {
  const viewsQ = useSavedViews();
  const archiveView = useArchiveView();

  const [menuOpen, setMenuOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<SavedView | null>(null);

  const views = viewsQ.data?.rows ?? [];

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" data-testid="saved-view-menu">
            <BookMarked className="mr-1.5 h-3.5 w-3.5" />
            Saved views
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Load a saved view</DropdownMenuLabel>
          {viewsQ.isLoading ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
          ) : views.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet.</div>
          ) : (
            views.map((v) => (
              <DropdownMenuItem
                key={v.id}
                className="flex items-start justify-between gap-2"
                onSelect={(e) => {
                  e.preventDefault();
                  onLoad(v);
                  toast.success(`Loaded "${v.name}"`);
                }}
                data-testid="saved-view-item"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {v.name}
                    {v.is_shared ? (
                      <Share2 className="h-3 w-3 text-muted-foreground" />
                    ) : (
                      <Lock className="h-3 w-3 text-muted-foreground" />
                    )}
                  </div>
                  {v.description && (
                    <div className="truncate text-xs text-muted-foreground">{v.description}</div>
                  )}
                </div>
                <button
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                  title="Archive view"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    setConfirmArchive(v);
                  }}
                  data-testid="archive-view"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              setSaveOpen(true);
            }}
            data-testid="open-save-view"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Save current view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save view dialog */}
      <SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} filters={filters} tab={tab} />

      {/* Archive confirmation */}
      <Dialog open={!!confirmArchive} onOpenChange={(v) => !v && setConfirmArchive(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive "{confirmArchive?.name}"?</DialogTitle>
            <DialogDescription>
              The view will be hidden from the list. This does not delete any underlying data.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmArchive(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={archiveView.isPending}
              onClick={() => {
                if (!confirmArchive) return;
                archiveView.mutate(confirmArchive.id, {
                  onSuccess: () => {
                    toast.success("View archived");
                    setConfirmArchive(null);
                  },
                  onError: (e) => toast.error(e.message),
                });
              }}
              data-testid="confirm-archive"
            >
              {archiveView.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Exported so the page test can drive the enabled-CTA validation directly
// without fighting the Radix dropdown portal in jsdom.
export function SaveViewDialog({
  open,
  onOpenChange,
  filters,
  tab,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  filters: AnalyticsFilters;
  tab: string;
}) {
  const createView = useCreateView();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isShared, setIsShared] = useState(false);

  function submitSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    createView.mutate(
      {
        name: trimmed,
        description: description.trim() || undefined,
        isShared,
        config: { ...filters, tab } as unknown as Record<string, unknown>,
      },
      {
        onSuccess: () => {
          toast.success(`Saved view "${trimmed}"`);
          onOpenChange(false);
          setName("");
          setDescription("");
          setIsShared(false);
        },
        onError: (e) => toast.error(e.message || "Could not save view"),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
          <DialogDescription>
            Persist the current date range, segments, and tab as a reusable view.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="view-name">Name</Label>
            <Input
              id="view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q2 Funnel Health"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="view-desc">Description (optional)</Label>
            <Textarea
              id="view-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this view tracks"
              rows={2}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="view-shared" checked={isShared} onCheckedChange={setIsShared} />
            <Label htmlFor="view-shared" className="text-sm">
              Share with the whole org
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submitSave}
            disabled={!name.trim() || createView.isPending}
            data-testid="save-view-submit"
          >
            {createView.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save view
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
