import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  ArrowRight,
  Bot,
  FlaskConical,
  GripVertical,
  Lock,
  Phone,
  PhoneForwarded,
  Save,
  Sparkles,
  Trash2,
  Users,
  Voicemail,
  X,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import type {
  TriageDestinationCatalog,
  TriageDestinationOption,
  TriageDestinationType as DestinationType,
  TriageFlow,
  TriageHandoffMode as HandoffMode,
  TriageRoutingRule,
} from "@j2w/shared-types";
import {
  useRoutingRules,
  useSaveRoutingRules,
  useTriageDestinations,
} from "@/hooks/useTriage";
import { DryRunPanel } from "@/components/triage/DryRunPanel";

// Hard-coded fallbacks used while the destination catalog is loading or
// when a destination type has no options yet (e.g. fresh org with no teams).
const FALLBACK_DESTINATIONS: TriageDestinationCatalog = {
  humanTeams: [{ id: "team-default", name: "Default Team" }],
  voiceAgents: [],
};

// ------------------------------------------------------------------ //
// Node types                                                         //
// ------------------------------------------------------------------ //

type FlowNodeData =
  | { kind: "start" }
  | { kind: "classifier"; intents: string[] }
  | {
      kind: "destination";
      rule: TriageRoutingRule;
      onEdit: (ruleId: string) => void;
      onDelete: (ruleId: string) => void;
      onToggle: (ruleId: string) => void;
    };

type FlowNode = Node<FlowNodeData>;

function StartNode() {
  return (
    <div className="rounded-lg border-2 border-primary/40 bg-primary/10 px-3 py-2.5 min-w-[180px] shadow-sm">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center">
          <Phone className="w-3.5 h-3.5" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-primary font-semibold">
            Start
          </div>
          <div className="text-sm font-semibold">Incoming call</div>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-primary !w-2 !h-2 !border-2 !border-background"
      />
    </div>
  );
}

function ClassifierNode({ data }: NodeProps<Node<{ kind: "classifier"; intents: string[] }>>) {
  return (
    <div className="rounded-lg border border-border bg-card min-w-[240px] shadow-sm">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <div className="w-7 h-7 rounded-md bg-primary/10 text-primary flex items-center justify-center">
          <Sparkles className="w-3.5 h-3.5" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
            AI classifier
          </div>
          <div className="text-sm font-semibold">Intent classification</div>
        </div>
      </div>
      <div className="p-2 space-y-1">
        {data.intents.map((intent, i) => (
          <div
            key={intent}
            className="relative flex items-center justify-between px-2 py-1 rounded bg-muted/50 text-xs"
          >
            <span className="font-medium capitalize">
              {intent === "*" ? "fallback (any)" : intent}
            </span>
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Handle
              type="source"
              position={Position.Right}
              id={`intent-${intent}`}
              style={{ top: `${((i + 0.5) / data.intents.length) * 100}%` }}
              className="!bg-primary !w-2 !h-2 !border-2 !border-background"
            />
          </div>
        ))}
      </div>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-primary !w-2 !h-2 !border-2 !border-background"
      />
    </div>
  );
}

function destinationIcon(t: DestinationType) {
  if (t === "human_team") return Users;
  if (t === "voice_agent") return Bot;
  if (t === "voicemail") return Voicemail;
  return PhoneForwarded;
}

function destinationTone(t: DestinationType) {
  if (t === "human_team") return "bg-primary/10 text-primary border-primary/30";
  if (t === "voice_agent") return "bg-success/10 text-success border-success/30";
  if (t === "voicemail") return "bg-muted text-muted-foreground border-border";
  return "bg-warning/10 text-warning border-warning/30";
}

function destinationTypeLabel(t: DestinationType): string {
  switch (t) {
    case "human_team":
      return "Human team";
    case "voice_agent":
      return "Voice agent";
    case "voicemail":
      return "Voicemail";
    case "external_pstn":
      return "External PSTN";
  }
}

function DestinationNode({
  data,
}: NodeProps<Node<{
  kind: "destination";
  rule: TriageRoutingRule;
  onEdit: (ruleId: string) => void;
  onDelete: (ruleId: string) => void;
  onToggle: (ruleId: string) => void;
}>>) {
  const Icon = destinationIcon(data.rule.destinationType);
  const tone = destinationTone(data.rule.destinationType);
  return (
    <div
      className={cn(
        "rounded-lg border bg-card min-w-[260px] shadow-sm group",
        !data.rule.enabled && "opacity-50",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        id={`intent-${data.rule.intent}`}
        className="!bg-primary !w-2 !h-2 !border-2 !border-background"
      />
      <div className={cn("px-3 py-2 rounded-t-lg border-b", tone)}>
        <div className="flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 shrink-0" />
          <div className="text-[10px] uppercase tracking-wide font-semibold">
            {destinationTypeLabel(data.rule.destinationType)}
          </div>
          <span className="ml-auto pill bg-background/70 text-[10px]">
            P{data.rule.priority}
          </span>
        </div>
      </div>
      <div className="p-3 space-y-2">
        <div className="text-sm font-semibold leading-tight truncate">
          {data.rule.destinationLabel}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="pill bg-primary/10 text-primary capitalize">
            {data.rule.intent === "*" ? "any" : data.rule.intent}
          </span>
          <span className="pill bg-muted text-muted-foreground capitalize">
            {data.rule.handoffMode}
          </span>
          {data.rule.conditions?.minConfidence != null && (
            <span className="pill bg-muted text-muted-foreground">
              ≥ {Math.round(data.rule.conditions.minConfidence * 100)}%
            </span>
          )}
        </div>
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5">
            <Switch
              checked={data.rule.enabled}
              onCheckedChange={() => data.onToggle(data.rule.id)}
              className="scale-75 origin-left"
            />
            <span className="text-[10px] text-muted-foreground">
              {data.rule.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={() => data.onEdit(data.rule.id)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => data.onDelete(data.rule.id)}
              title="Delete rule"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  start: StartNode,
  classifier: ClassifierNode,
  destination: DestinationNode,
};

// ------------------------------------------------------------------ //
// Builder                                                            //
// ------------------------------------------------------------------ //

interface RoutingFlowBuilderProps {
  flow: TriageFlow;
  canWrite?: boolean;
}

export function RoutingFlowBuilder({ flow, canWrite = true }: RoutingFlowBuilderProps) {
  return (
    <ReactFlowProvider>
      <RoutingFlowBuilderInner flow={flow} canWrite={canWrite} />
    </ReactFlowProvider>
  );
}

function buildNodesAndEdges(
  flow: TriageFlow,
  rules: TriageRoutingRule[],
  handlers: {
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
    onToggle: (id: string) => void;
  },
): { nodes: FlowNode[]; edges: Edge[] } {
  const intentVocabulary = flow.intentVocabulary.includes("*")
    ? flow.intentVocabulary
    : [...flow.intentVocabulary, "*"];

  const nodes: FlowNode[] = [
    {
      id: "start",
      type: "start",
      position: { x: 40, y: 220 },
      data: { kind: "start" },
      draggable: false,
    },
    {
      id: "classifier",
      type: "classifier",
      position: { x: 280, y: 80 },
      data: { kind: "classifier", intents: intentVocabulary },
    },
    ...rules.map<FlowNode>((r) => ({
      id: `rule-${r.id}`,
      type: "destination",
      position: r.uiPosition,
      data: { kind: "destination", rule: r, ...handlers },
    })),
  ];

  const edges: Edge[] = [
    {
      id: "e-start-classifier",
      source: "start",
      target: "classifier",
      animated: true,
      style: { stroke: "hsl(var(--primary))", strokeWidth: 2 },
    },
    ...rules.map<Edge>((r) => ({
      id: `e-classifier-rule-${r.id}`,
      source: "classifier",
      sourceHandle: `intent-${r.intent}`,
      target: `rule-${r.id}`,
      targetHandle: `intent-${r.intent}`,
      animated: r.enabled,
      style: {
        stroke: r.enabled ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
        strokeWidth: 2,
        strokeDasharray: r.enabled ? undefined : "6 4",
      },
    })),
  ];
  return { nodes, edges };
}

function RoutingFlowBuilderInner({ flow, canWrite = true }: RoutingFlowBuilderProps) {
  const { data: rules = [] } = useRoutingRules(flow.id);
  const { data: destinationsData } = useTriageDestinations();
  const destinations = destinationsData ?? FALLBACK_DESTINATIONS;
  const save = useSaveRoutingRules(flow.id);
  const { fitView } = useReactFlow();

  // Local working copy. Syncs on flow/rules change but tracks dirty.
  const [local, setLocal] = useState<TriageRoutingRule[]>(rules);
  useEffect(() => {
    setLocal(rules);
  }, [rules]);

  const dirty = useMemo(() => JSON.stringify(local) !== JSON.stringify(rules), [local, rules]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [dryRunOpen, setDryRunOpen] = useState(false);
  // Server-side validation issues surfaced after a failed save.
  const [serverIssues, setServerIssues] = useState<string[]>([]);

  // Client-side pre-validation mirrors the server's rules so the operator sees
  // problems before hitting Save (duplicate priority, missing '*', unresolved).
  const localIssues = useMemo(() => validateRulesClient(local), [local]);

  const onEdit = useCallback((id: string) => setEditingId(id), []);
  const onDelete = useCallback(
    (id: string) => {
      setLocal((rs) =>
        rs
          .filter((r) => r.id !== id)
          .map((r, i) => ({ ...r, priority: i + 1 })),
      );
    },
    [],
  );
  const onToggle = useCallback(
    (id: string) =>
      setLocal((rs) => rs.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))),
    [],
  );

  const handlers = useMemo(() => ({ onEdit, onDelete, onToggle }), [onEdit, onDelete, onToggle]);

  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildNodesAndEdges(flow, local, handlers),
    [flow, local, handlers],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Rebuild when rules change.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Commit node drag position back into rule uiPosition.
  const onNodesChangeWrapped = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      onNodesChange(changes);
      const positionChanges = changes.filter(
        (c): c is Extract<NodeChange<FlowNode>, { type: "position" }> =>
          c.type === "position" && c.dragging === false && !!c.position,
      );
      if (positionChanges.length === 0) return;
      setLocal((rs) =>
        rs.map((r) => {
          const ch = positionChanges.find((c) => c.id === `rule-${r.id}`);
          if (!ch || !ch.position) return r;
          return { ...r, uiPosition: { x: ch.position.x, y: ch.position.y } };
        }),
      );
    },
    [onNodesChange],
  );

  const onEdgesChangeWrapped = useCallback(
    (changes: EdgeChange[]) => onEdgesChange(changes),
    [onEdgesChange],
  );

  const onConnect = useCallback(
    (conn: Connection) => setEdges((eds) => addEdge({ ...conn, animated: true }, eds)),
    [setEdges],
  );

  const addDestination = (type: DestinationType) => {
    const id = `rule-new-${Date.now()}`;
    const defaultDest = pickDefaultDestination(type, destinations);

    const newRule: TriageRoutingRule = {
      id,
      flowId: flow.id,
      priority: local.length + 1,
      intent: flow.intentVocabulary[0] ?? "*",
      destinationType: type,
      destinationRef: defaultDest.id,
      destinationLabel: defaultDest.name,
      handoffMode: type === "voicemail" ? "voicemail" : "warm",
      enabled: true,
      uiPosition: { x: 1040, y: 80 + local.length * 150 },
      slaTargetSec: type === "human_team" ? 60 : null,
      routingStrategy: "first_idle",
      weight: 1,
      maxConcurrent: null,
      requiredSkill: null,
    };
    setLocal((rs) => [...rs, newRule]);
    setEditingId(id);
  };

  const editingRule = local.find((r) => r.id === editingId) ?? null;

  async function handleSave() {
    setServerIssues([]);
    try {
      await save.mutateAsync(local);
      toast.success("Draft saved");
    } catch (e) {
      const body = (e as { body?: { error?: string; issues?: unknown } }).body;
      const issues = Array.isArray(body?.issues)
        ? (body!.issues as string[])
        : body?.error === "invalid_rules" || body?.error === "invalid_payload"
          ? ["The rule set failed validation."]
          : [];
      if (issues.length) {
        setServerIssues(issues);
        toast.error("Fix the validation errors and save again");
      } else {
        toast.error(e instanceof Error ? e.message : "Save failed");
      }
    }
  }

  function resetLayout() {
    const reset = local.map((r, i) => ({ ...r, uiPosition: { x: 720, y: 60 + i * 140 } }));
    setLocal(reset);
    setTimeout(() => fitView({ padding: 0.2 }), 20);
  }

  const paletteRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-[620px] border border-border rounded-lg overflow-hidden bg-background">
      {/* Palette */}
      <div
        ref={paletteRef}
        className="w-56 shrink-0 border-r border-border bg-card flex flex-col"
      >
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
            Add destination
          </div>
        </div>
        <div className="p-2 space-y-1">
          {canWrite ? (
            <>
              <PaletteButton
                icon={Users}
                label="Human team"
                hint="Warm-transfer to a team"
                tone="primary"
                onClick={() => addDestination("human_team")}
              />
              <PaletteButton
                icon={Bot}
                label="Voice agent"
                hint="Handoff to a specialist bot"
                tone="success"
                onClick={() => addDestination("voice_agent")}
              />
              <PaletteButton
                icon={PhoneForwarded}
                label="External PSTN"
                hint="Forward to a phone number"
                tone="warning"
                onClick={() => addDestination("external_pstn")}
              />
              <PaletteButton
                icon={Voicemail}
                label="Voicemail"
                hint="Take a message"
                tone="muted"
                onClick={() => addDestination("voicemail")}
              />
            </>
          ) : (
            <div className="rounded-md border border-border bg-muted/40 p-2.5 text-[11px] text-muted-foreground flex items-start gap-2">
              <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>You have read-only access. Editing requires triage.write.</span>
            </div>
          )}
        </div>

        {(localIssues.length > 0 || serverIssues.length > 0) && (
          <div className="px-2 pb-2">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-destructive font-semibold flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Validation
              </div>
              {[...serverIssues, ...localIssues].slice(0, 5).map((msg, i) => (
                <div key={i} className="text-[11px] text-destructive leading-tight">
                  • {msg}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-auto p-2 border-t border-border space-y-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs justify-start"
            onClick={() => setDryRunOpen((v) => !v)}
            data-testid="open-dry-run"
          >
            <FlaskConical className="w-3 h-3 mr-1.5" />
            Dry-run vs history
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs justify-start"
            onClick={resetLayout}
            disabled={!canWrite}
          >
            <GripVertical className="w-3 h-3 mr-1.5" />
            Reset layout
          </Button>
          <Button
            size="sm"
            className="w-full h-8 text-xs"
            onClick={handleSave}
            disabled={!canWrite || !dirty || save.isPending || localIssues.length > 0}
            data-testid="save-draft"
          >
            <Save className="w-3 h-3 mr-1.5" />
            {save.isPending ? "Saving…" : dirty ? "Save draft" : "Saved"}
          </Button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-w-0 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChangeWrapped}
          onEdgesChange={onEdgesChangeWrapped}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              n.type === "start"
                ? "hsl(var(--primary))"
                : n.type === "classifier"
                  ? "hsl(var(--primary) / 0.5)"
                  : "hsl(var(--muted-foreground))"
            }
          />
        </ReactFlow>

        {dryRunOpen && (
          <DryRunPanel
            flowId={flow.id}
            candidateRules={local}
            onClose={() => setDryRunOpen(false)}
          />
        )}
      </div>

      {editingRule && (
        <RuleEditPanel
          rule={editingRule}
          intents={flow.intentVocabulary}
          destinations={destinations}
          onClose={() => setEditingId(null)}
          onChange={(patch) =>
            setLocal((rs) =>
              rs.map((r) => (r.id === editingRule.id ? { ...r, ...patch } : r)),
            )
          }
        />
      )}
    </div>
  );
}

function pickDefaultDestination(
  type: DestinationType,
  destinations: TriageDestinationCatalog,
): TriageDestinationOption {
  if (type === "human_team") {
    return destinations.humanTeams[0] ?? { id: "team-default", name: "Default Team" };
  }
  if (type === "voice_agent") {
    return (
      destinations.voiceAgents[0] ?? { id: "voice-agent-default", name: "Specialist Bot" }
    );
  }
  if (type === "voicemail") {
    return { id: "vm-general", name: "General Voicemail" };
  }
  return { id: "+91 9800000000", name: "External line" };
}

function PaletteButton({
  icon: Icon,
  label,
  hint,
  tone,
  onClick,
}: {
  icon: typeof Users;
  label: string;
  hint: string;
  tone: "primary" | "success" | "warning" | "muted";
  onClick: () => void;
}) {
  const toneClass =
    tone === "primary"
      ? "bg-primary/10 text-primary"
      : tone === "success"
        ? "bg-success/10 text-success"
        : tone === "warning"
          ? "bg-warning/10 text-warning"
          : "bg-muted text-muted-foreground";
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-md border border-border hover:bg-muted/60 hover:border-primary/40 transition-colors p-2 flex items-start gap-2"
    >
      <div className={cn("w-7 h-7 rounded-md shrink-0 flex items-center justify-center", toneClass)}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold leading-tight">{label}</div>
        <div className="text-[10px] text-muted-foreground">{hint}</div>
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ //
// Side panel for editing an individual rule                           //
// ------------------------------------------------------------------ //

interface RuleEditPanelProps {
  rule: TriageRoutingRule;
  intents: string[];
  destinations: TriageDestinationCatalog;
  onChange: (patch: Partial<TriageRoutingRule>) => void;
  onClose: () => void;
}

function RuleEditPanel({ rule, intents, destinations, onChange, onClose }: RuleEditPanelProps) {
  const intentOptions = intents.includes("*") ? intents : [...intents, "*"];
  const destOptions =
    rule.destinationType === "human_team"
      ? destinations.humanTeams
      : rule.destinationType === "voice_agent"
        ? destinations.voiceAgents
        : [];

  return (
    <div className="w-[320px] shrink-0 border-l border-border bg-card flex flex-col overflow-y-auto">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
            Rule
          </div>
          <div className="text-sm font-semibold truncate">
            Priority {rule.priority}
          </div>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="p-3 space-y-4">
        <Field label="When intent is">
          <Select
            value={rule.intent}
            onValueChange={(v) => onChange({ intent: v })}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {intentOptions.map((i) => (
                <SelectItem key={i} value={i}>
                  {i === "*" ? "any (fallback)" : i}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Destination type">
          <Select
            value={rule.destinationType}
            onValueChange={(v) => {
              const t = v as DestinationType;
              const first = pickDefaultDestination(t, destinations);
              onChange({
                destinationType: t,
                destinationRef: first.id,
                destinationLabel: first.name,
                handoffMode: t === "voicemail" ? "voicemail" : "warm",
              });
            }}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="human_team">Human team</SelectItem>
              <SelectItem value="voice_agent">Voice agent</SelectItem>
              <SelectItem value="external_pstn">External PSTN</SelectItem>
              <SelectItem value="voicemail">Voicemail</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {destOptions.length > 0 ? (
          <Field label="Target">
            <Select
              value={rule.destinationRef}
              onValueChange={(v) => {
                const opt = destOptions.find((o) => o.id === v);
                if (opt)
                  onChange({ destinationRef: opt.id, destinationLabel: opt.name });
              }}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {destOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Field label={rule.destinationType === "external_pstn" ? "Phone number" : "Mailbox"}>
            <Input
              value={rule.destinationRef}
              onChange={(e) =>
                onChange({
                  destinationRef: e.target.value,
                  destinationLabel: e.target.value,
                })
              }
              className="h-8 text-sm font-mono"
              placeholder="+91 9800000000"
            />
          </Field>
        )}

        {rule.destinationType !== "voicemail" && (
          <Field label="Handoff mode">
            <div className="grid grid-cols-2 gap-1">
              {(["warm", "cold"] as HandoffMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onChange({ handoffMode: m })}
                  className={cn(
                    "px-2 py-1.5 text-xs rounded border capitalize",
                    rule.handoffMode === m
                      ? "border-primary bg-primary/10 text-primary font-semibold"
                      : "border-border hover:bg-muted/50",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {rule.handoffMode === "warm"
                ? "Triage transcript + classification passed to recipient."
                : "Blind transfer — no context passed."}
            </p>
          </Field>
        )}

        <Field label={`Minimum confidence (${Math.round((rule.conditions?.minConfidence ?? 0) * 100)}%)`}>
          <Slider
            value={[Math.round((rule.conditions?.minConfidence ?? 0) * 100)]}
            onValueChange={([v]) =>
              onChange({
                conditions: { ...rule.conditions, minConfidence: v / 100 },
              })
            }
            min={0}
            max={100}
            step={5}
          />
        </Field>

        <Field label="SLA target (seconds)">
          <Input
            type="number"
            min={5}
            max={3600}
            value={rule.slaTargetSec ?? ""}
            onChange={(e) => {
              const v = e.target.value.trim();
              onChange({ slaTargetSec: v === "" ? null : Math.max(5, Math.min(3600, Number(v))) });
            }}
            placeholder="No SLA"
            className="h-8 text-sm"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Time from triage start to completed handoff before a breach (5–3600s).
          </p>
        </Field>

        {rule.destinationType === "human_team" && (
          <>
            <Field label="Routing strategy">
              <Select
                value={rule.routingStrategy ?? "first_idle"}
                onValueChange={(v) =>
                  onChange({ routingStrategy: v as TriageRoutingRule["routingStrategy"] })
                }
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="first_idle">First idle</SelectItem>
                  <SelectItem value="round_robin">Round robin</SelectItem>
                  <SelectItem value="weighted">Weighted</SelectItem>
                  <SelectItem value="least_loaded">Least loaded</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {rule.routingStrategy === "weighted" && (
              <Field label={`Weight (${rule.weight ?? 1})`}>
                <Slider
                  value={[rule.weight ?? 1]}
                  onValueChange={([v]) => onChange({ weight: v })}
                  min={1}
                  max={100}
                  step={1}
                />
              </Field>
            )}

            <Field label="Required skill (optional)">
              <Input
                value={rule.requiredSkill ?? ""}
                onChange={(e) =>
                  onChange({ requiredSkill: e.target.value.trim() || null })
                }
                placeholder="e.g. hindi"
                className="h-8 text-sm"
                maxLength={64}
              />
            </Field>
          </>
        )}

        <div className="flex items-center justify-between">
          <label className="text-xs font-medium">Enabled</label>
          <Switch
            checked={rule.enabled}
            onCheckedChange={(v) => onChange({ enabled: v })}
          />
        </div>

        <div className="text-[10px] text-muted-foreground pt-2 border-t border-border">
          Changes stay local until you click <span className="font-semibold">Save draft</span> on
          the left, then <span className="font-semibold">Publish</span> to go live.
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1.5">{label}</label>
      {children}
    </div>
  );
}

// Mirrors the server-side validateRules so the operator sees problems before
// saving (duplicate priority, missing '*' fallback, unresolved destination,
// weight out of range, SLA out of range). Returns human-readable messages.
function validateRulesClient(rules: TriageRoutingRule[]): string[] {
  const issues: string[] = [];
  if (rules.length === 0) return issues;

  const priorities = new Set<number>();
  for (const r of rules) {
    if (priorities.has(r.priority)) {
      issues.push(`Duplicate priority P${r.priority} — priorities must be unique.`);
    }
    priorities.add(r.priority);

    if (!r.destinationRef || !r.destinationRef.trim()) {
      issues.push(`Rule P${r.priority} (${r.intent}) has no destination set.`);
    }
    if (r.weight != null && (r.weight < 1 || r.weight > 100)) {
      issues.push(`Rule P${r.priority} weight must be between 1 and 100.`);
    }
    if (r.slaTargetSec != null && (r.slaTargetSec < 5 || r.slaTargetSec > 3600)) {
      issues.push(`Rule P${r.priority} SLA must be between 5 and 3600 seconds.`);
    }
  }

  const fallbacks = rules.filter((r) => r.intent === "*");
  if (fallbacks.length === 0) {
    issues.push("Add a '*' fallback rule so every call routes somewhere.");
  } else if (fallbacks.length > 1) {
    issues.push("Only one '*' fallback rule is allowed.");
  }

  return Array.from(new Set(issues));
}
