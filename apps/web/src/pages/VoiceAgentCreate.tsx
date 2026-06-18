import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { GitBranch } from "lucide-react";
import type { CreateVoiceAgentInput, VoiceAgentLanguage } from "@j2w/shared-types";
import { PageHeader, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCreateVoiceAgent } from "@/hooks/useVoiceAgents";

type Template = NonNullable<CreateVoiceAgentInput["template"]>;

const TEMPLATES: Array<{ id: Template; name: string; description: string }> = [
  {
    id: "support",
    name: "General Screen — Hinglish",
    description: "5-minute interest gauge. Confirms candidate is actively looking, captures CTC, notice period, and location.",
  },
  {
    id: "billing",
    name: "Technical Screen",
    description: "8–12 minute technical depth screen. Asks 3–5 questions tied to the demand's must-have skills.",
  },
  {
    id: "scheduler",
    name: "Notice Period & Comp Check",
    description: "4-minute alignment check. States the demand's CTC band and notice expectation up front, captures candidate's numbers.",
  },
  {
    id: "blank",
    name: "Blank",
    description: "Start from scratch with a custom prompt and tools.",
  },
];

// Phase 1: triage uses its own template list surface but maps to the existing
// Template enum. Phase 2 will add dedicated triage templates on the server.
const TRIAGE_TEMPLATES: Array<{ id: Template; name: string; description: string }> = [
  {
    id: "support",
    name: "Generic Triage",
    description: "Greets callers, classifies intent across billing/technical/sales, routes.",
  },
  {
    id: "support",
    name: "Support Triage",
    description: "Focused on support — diagnose urgency and route to the right specialist.",
  },
  {
    id: "billing",
    name: "Sales Triage",
    description: "Qualifies inbound sales, warm-transfers to AEs based on deal size.",
  },
  {
    id: "blank",
    name: "Blank",
    description: "Start from scratch — define your own classification vocabulary.",
  },
];

const LANGUAGES: Array<{ id: VoiceAgentLanguage; name: string; hint: string }> = [
  { id: "multi", name: "Hinglish (Hindi + English)", hint: "Recommended — Deepgram multilingual" },
  { id: "hi-IN", name: "Hindi", hint: "Pure Hindi" },
  { id: "en-IN", name: "Indian English", hint: "English with Indian accent" },
  { id: "en-US", name: "US English", hint: "" },
];

export default function VoiceAgentCreate() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const isTriage = params.get("kind") === "triage";
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<VoiceAgentLanguage>("multi");
  const [templateIdx, setTemplateIdx] = useState(0);
  const templates = isTriage ? TRIAGE_TEMPLATES : TEMPLATES;
  const create = useCreateVoiceAgent();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    try {
      const prefixedName = isTriage && !name.toLowerCase().includes("triage")
        ? `${name.trim()} (Triage)`
        : name.trim();
      const agent = await create.mutateAsync({
        name: prefixedName,
        kind: isTriage ? "triage" : undefined,
        language,
        template: isTriage ? "triage" : templates[templateIdx].id,
      });
      toast.success(isTriage ? "Triage flow created" : "Voice agent created");
      nav(isTriage ? `/triage/flows/${agent.id}` : `/voice-agents/${agent.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    }
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={
          isTriage
            ? [
                { label: "Triage", href: "/triage" },
                { label: "New flow" },
              ]
            : [
                { label: "Voice Agents", href: "/voice-agents" },
                { label: "New" },
              ]
        }
        title={isTriage ? "Create triage flow" : "Create voice agent"}
        subtitle={
          isTriage
            ? "An AI voice agent that classifies incoming calls and routes them to the right destination."
            : "Start with a template — you can customize everything after."
        }
      />
      <form onSubmit={submit} className="p-6 space-y-5 max-w-3xl">
        {isTriage && (
          <div className="flex items-start gap-3 p-4 rounded-lg bg-primary/5 border border-primary/20">
            <div className="w-8 h-8 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <GitBranch className="w-4 h-4" />
            </div>
            <div className="text-sm">
              <div className="font-semibold">You&apos;re creating a triage flow.</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                After creation, configure routing rules under{" "}
                <span className="font-medium">Triage → Flows</span> to control where classified
                calls are sent.
              </div>
            </div>
          </div>
        )}
        <Card title="Basics">
          <div className="p-5 space-y-4">
            <div>
              <label className="text-xs font-medium block mb-1.5">
                {isTriage ? "Flow name" : "Agent name"}
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isTriage ? "e.g. Front-desk Triage" : "e.g. Billing Assistant"}
                required
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">Primary language</label>
              <div className="grid grid-cols-2 gap-2">
                {LANGUAGES.map((l) => (
                  <button
                    type="button"
                    key={l.id}
                    onClick={() => setLanguage(l.id)}
                    className={cn(
                      "text-left border rounded p-3 hover:bg-muted/40",
                      language === l.id ? "border-primary bg-primary-muted/40" : "border-border",
                    )}
                  >
                    <div className="text-sm font-medium">{l.name}</div>
                    {l.hint && <div className="text-xs text-muted-foreground">{l.hint}</div>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card title="Template">
          <div className="p-5 grid grid-cols-2 gap-2">
            {templates.map((t, i) => (
              <button
                type="button"
                key={`${t.id}-${i}`}
                onClick={() => setTemplateIdx(i)}
                className={cn(
                  "text-left border rounded p-3 hover:bg-muted/40",
                  templateIdx === i ? "border-primary bg-primary-muted/40" : "border-border",
                )}
              >
                <div className="text-sm font-medium">{t.name}</div>
                <div className="text-xs text-muted-foreground">{t.description}</div>
              </button>
            ))}
          </div>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => nav(isTriage ? "/triage" : "/voice-agents")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : isTriage ? "Create flow" : "Create agent"}
          </Button>
        </div>
      </form>
    </div>
  );
}
