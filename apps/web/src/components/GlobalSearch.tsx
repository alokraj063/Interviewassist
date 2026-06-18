import { useNavigate } from "react-router-dom";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { AGENTS, CONVERSATIONS, SCORECARDS, TRAINING } from "@/data/store";
import { useEffect } from "react";

export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const nav = useNavigate();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  function go(path: string) {
    onOpenChange(false);
    nav(path);
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search conversations, agents, scorecards, coaching…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Conversations">
          {CONVERSATIONS.slice(0, 6).map(c => (
            <CommandItem key={c.id} onSelect={() => go(`/conversations/${c.id}`)}>
              <span className="font-mono text-xs text-muted-foreground mr-2">{c.id}</span>
              {c.intent} — {c.customerName}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Agents">
          {AGENTS.slice(0, 6).map(a => (
            <CommandItem key={a.id} onSelect={() => go(`/agents/${a.id}`)}>
              {a.name} <span className="ml-auto text-xs text-muted-foreground">{a.region}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Scorecards">
          {SCORECARDS.map(s => (
            <CommandItem key={s.id} onSelect={() => go(`/scorecards/${s.id}`)}>{s.name}</CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Training">
          {TRAINING.slice(0, 5).map(t => (
            <CommandItem key={t.id} onSelect={() => go(`/coaching`)}>{t.title}</CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
