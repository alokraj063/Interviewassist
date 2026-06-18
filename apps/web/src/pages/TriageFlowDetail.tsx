import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Mic,
  Phone,
  Pencil,
  ArrowLeft,
  Clock,
  ListChecks,
  Activity,
  Settings as SettingsIcon,
} from "lucide-react";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useLiveTriageSessions,
  useRoutingRules,
  useTriageFlow,
} from "@/hooks/useTriage";
import { RoutingFlowBuilder } from "@/components/triage/RoutingFlowBuilder";
import { RuleSetVersionBar } from "@/components/triage/RuleSetVersionBar";
import { ConfigAuditTimeline } from "@/components/triage/ConfigAuditTimeline";
import { TriageSessionDrawer } from "@/components/triage/TriageSessionDrawer";
import { TestCallDrawer } from "@/components/voice-agent/TestCallDrawer";
import { useCan } from "@/auth/AuthContext";

const TABS = ["Routing", "Recent sessions", "Configuration"] as const;
type Tab = (typeof TABS)[number];

export default function TriageFlowDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, isLoading } = useTriageFlow(id);
  const flow = data?.flow ?? null;
  const [tab, setTab] = useState<Tab>("Routing");
  const [testOpen, setTestOpen] = useState(false);

  if (isLoading) {
    return (
      <div>
        <PageHeader
          breadcrumbs={[{ label: "Triage", href: "/triage" }, { label: "…" }]}
          title="Loading…"
        />
      </div>
    );
  }

  if (!flow) {
    return (
      <div>
        <PageHeader
          breadcrumbs={[{ label: "Triage", href: "/triage" }, { label: "Not found" }]}
          title="Triage flow not found"
          actions={
            <Button variant="outline" size="sm" onClick={() => nav("/triage")}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
              Back to Triage
            </Button>
          }
        />
      </div>
    );
  }

  const statusTone =
    flow.status === "active"
      ? "bg-success/15 text-success"
      : flow.status === "paused"
        ? "bg-warning/15 text-warning"
        : "bg-muted text-muted-foreground";

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: "Triage", href: "/triage" },
          { label: "Flows" },
          { label: flow.name },
        ]}
        title={flow.name}
        subtitle={flow.purpose}
        actions={
          <>
            <span className={cn("pill text-[10px] capitalize", statusTone)}>
              {flow.status}
            </span>
            <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
              <Mic className="w-3.5 h-3.5 mr-1.5" />
              Test call
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => nav(`/voice-agents/${flow.voiceAgentId}`)}
            >
              <Pencil className="w-3.5 h-3.5 mr-1.5" />
              Edit voice agent
            </Button>
          </>
        }
      />

      <div className="px-6 pt-4 border-b border-border bg-background flex gap-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px inline-flex items-center gap-1.5",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tabIcon(t)}
            {t}
          </button>
        ))}
      </div>

      <div className="p-6 space-y-4">
        {tab === "Routing" && <RoutingTabContent flow={flow} />}
        {tab === "Recent sessions" && <SessionsTabContent flowId={flow.id} />}
        {tab === "Configuration" && <ConfigTabContent flow={flow} />}
      </div>

      {flow.voiceAgentId && (
        <TestCallDrawer
          agentId={flow.voiceAgentId}
          open={testOpen}
          onOpenChange={setTestOpen}
        />
      )}
    </div>
  );
}

function tabIcon(t: Tab) {
  const cls = "w-3.5 h-3.5";
  if (t === "Routing") return <ListChecks className={cls} />;
  if (t === "Recent sessions") return <Activity className={cls} />;
  return <SettingsIcon className={cls} />;
}

function RoutingTabContent({ flow }: { flow: Parameters<typeof RoutingFlowBuilder>[0]["flow"] }) {
  const { data: rules = [] } = useRoutingRules(flow.id);
  const canWrite = useCan("triage.write");
  const enabled = rules.filter((r) => r.enabled).length;
  return (
    <>
      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Rules" value={rules.length} />
        <MetricCard label="Enabled" value={enabled} accent="success" />
        <MetricCard
          label="Intents covered"
          value={new Set(rules.map((r) => r.intent)).size}
        />
        <MetricCard label="Fallback" value={rules.some((r) => r.intent === "*") ? "Yes" : "No"} />
      </div>
      <RuleSetVersionBar flowId={flow.id} canWrite={canWrite} />
      <RoutingFlowBuilder flow={flow} canWrite={canWrite} />
    </>
  );
}

function SessionsTabContent({ flowId }: { flowId: string }) {
  const { data } = useLiveTriageSessions({ flowId });
  const forFlow = data?.sessions ?? [];
  const [openCallId, setOpenCallId] = useState<string | null>(null);

  return (
    <>
      <Card title="Recent triage sessions">
        {forFlow.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground text-center">
            No recent triage sessions for this flow.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Caller</th>
                <th>Intent</th>
                <th>Confidence</th>
                <th>Status</th>
                <th>Destination</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forFlow.map((s) => (
                <tr
                  key={s.callId}
                  className="cursor-pointer"
                  onClick={() => setOpenCallId(s.callId)}
                >
                  <td className="font-mono text-xs">{s.callerRef}</td>
                  <td className="capitalize text-xs">{s.classification.intent}</td>
                  <td className="tabular-nums text-xs">
                    {Math.round(s.classification.confidence * 100)}%
                  </td>
                  <td className="text-xs capitalize">
                    {s.status.replace("_", " ")}
                  </td>
                  <td className="text-xs">{s.destinationLabel ?? "—"}</td>
                  <td className="text-xs text-muted-foreground">
                    {new Date(s.startedAt).toLocaleTimeString()}
                  </td>
                  <td className="text-right">
                    <Button variant="ghost" size="sm" className="h-7 text-xs">
                      Inspect
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <TriageSessionDrawer
        callId={openCallId}
        open={!!openCallId}
        onOpenChange={(o) => !o && setOpenCallId(null)}
      />
    </>
  );
}

function ConfigTabContent({ flow }: { flow: Parameters<typeof RoutingFlowBuilder>[0]["flow"] }) {
  const nav = useNavigate();
  return (
    <>
      <ConfigAuditTimeline flowId={flow.id} />
      <Card title="Flow configuration">
        <div className="p-5 grid grid-cols-2 gap-4 text-sm">
          <InfoRow label="Name" value={flow.name} />
          <InfoRow label="Status" value={flow.status} />
          <InfoRow label="Phone number" value={flow.phoneNumber ?? "—"} mono />
          <InfoRow
            label="Primary language"
            value={flow.language === "multi" ? "Hinglish (Hindi + English)" : flow.language}
          />
          <InfoRow
            label="Intent vocabulary"
            value={flow.intentVocabulary.join(", ")}
            className="col-span-2"
          />
          <InfoRow label="Purpose" value={flow.purpose} className="col-span-2" />
          <InfoRow
            label="Linked voice agent"
            value={flow.voiceAgentId}
            mono
            className="col-span-2"
          />
        </div>
        <div className="px-5 pb-5 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => nav(`/voice-agents/${flow.voiceAgentId}`)}>
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Edit voice agent
          </Button>
          <p className="text-xs text-muted-foreground">
            Prompt, voice, transcriber, tools, and knowledge base are configured on the underlying
            voice agent.
          </p>
        </div>
      </Card>

      <Card title="Triage agent behavior">
        <div className="p-5 space-y-3 text-sm">
          <p className="text-muted-foreground">
            The triage agent greets every incoming call, holds a short classification conversation
            (usually 2–4 turns), then invokes the <code className="text-xs">routeCall</code> tool
            with a detected intent and confidence. Your routing rules decide where the call goes
            next.
          </p>
          <div className="rounded-md bg-muted/50 p-3 space-y-1.5 text-xs">
            <div className="font-semibold">
              <Phone className="w-3 h-3 inline mr-1" />
              Typical conversation
            </div>
            <div>
              <span className="text-muted-foreground">Agent:</span> &ldquo;Namaste, J2W support. Main
              aapki kaise madad kar sakta hoon?&rdquo;
            </div>
            <div>
              <span className="text-muted-foreground">Caller:</span> &ldquo;My printer is not working
              properly — it keeps showing an error.&rdquo;
            </div>
            <div>
              <span className="text-muted-foreground">Agent (internal):</span>{" "}
              <code>routeCall({"{ intent: 'technical', confidence: 0.91 }"})</code>
            </div>
            <div>
              <span className="text-muted-foreground">Agent:</span> &ldquo;I&apos;ll connect you to
              our technical assistant right now.&rdquo;{" "}
              <Clock className="w-3 h-3 inline" /> handoff
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}

function InfoRow({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md bg-muted/40 px-3 py-2", className)}>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-sm capitalize-first", mono && "font-mono text-xs")}>
        {value}
      </div>
    </div>
  );
}
