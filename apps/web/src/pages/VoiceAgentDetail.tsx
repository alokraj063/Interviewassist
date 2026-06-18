import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Mic,
  Phone,
  Play,
  Plus,
  Power,
  Rocket,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  VapiVoiceOption,
  VoiceAgent,
  VoiceAgentLanguage,
  VoiceAgentTool,
  UpdateVoiceAgentInput,
} from "@j2w/shared-types";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { TestCallDrawer } from "@/components/voice-agent/TestCallDrawer";
import {
  useDeleteVoiceAgent,
  useDeployVoiceAgent,
  useUpdateVoiceAgent,
  useVapiVoices,
  useVoiceAgent,
  useVoiceAgentCalls,
  useVoiceAgentStats,
} from "@/hooks/useVoiceAgents";
import { useKbSources } from "@/hooks/useKnowledge";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

const TABS = ["Overview", "Configuration", "Conversations", "Monitor", "Deployment"] as const;
const CONFIG_TABS = [
  "Persona",
  "Prompt",
  "Voice",
  "Tools",
  "Knowledge",
  "Escalation",
  "Compliance",
  "Advanced",
] as const;

type Tab = (typeof TABS)[number];
type ConfigTab = (typeof CONFIG_TABS)[number];

export default function VoiceAgentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, isLoading, error } = useVoiceAgent(id);
  const update = useUpdateVoiceAgent(id ?? "");
  const deploy = useDeployVoiceAgent(id ?? "");
  const del = useDeleteVoiceAgent();

  const [tab, setTab] = useState<Tab>("Configuration");
  const [cfgTab, setCfgTab] = useState<ConfigTab>("Persona");
  const [testOpen, setTestOpen] = useState(false);

  // Local draft of the agent we're editing. Reset whenever the server copy
  // refreshes (e.g. after save/deploy).
  const [draft, setDraft] = useState<VoiceAgent | null>(null);
  useEffect(() => {
    if (data?.agent) setDraft(data.agent);
  }, [data?.agent]);

  const dirty = useMemo(() => {
    if (!data?.agent || !draft) return false;
    return JSON.stringify(data.agent) !== JSON.stringify(draft);
  }, [data?.agent, draft]);

  if (isLoading || !draft) {
    return (
      <div>
        <PageHeader
          breadcrumbs={[{ label: "Voice Agents", href: "/voice-agents" }, { label: "…" }]}
          title="Loading…"
        />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div>
        <PageHeader
          breadcrumbs={[{ label: "Voice Agents", href: "/voice-agents" }, { label: "Error" }]}
          title="Voice agent not found"
        />
      </div>
    );
  }

  const agent = draft;

  async function save() {
    if (!dirty) {
      toast.info("No changes");
      return;
    }
    // Guard against half-typed tool names / URLs that would 400 on the server.
    for (const t of agent.tools) {
      if (!TOOL_NAME_RE.test(t.name)) {
        toast.error(`Tool "${t.name}" has an invalid name`);
        setTab("Configuration");
        setCfgTab("Tools");
        return;
      }
      if (
        t.fulfillmentUrl &&
        !t.fulfillmentUrl.startsWith("http://") &&
        !t.fulfillmentUrl.startsWith("https://")
      ) {
        toast.error(`Tool "${t.name}" has an invalid fulfillment URL`);
        setTab("Configuration");
        setCfgTab("Tools");
        return;
      }
    }
    const patch: UpdateVoiceAgentInput = {
      name: agent.name,
      status: agent.status,
      purpose: agent.purpose,
      systemPrompt: agent.systemPrompt,
      firstMessage: agent.firstMessage,
      language: agent.language,
      transcriberProvider: agent.transcriberProvider,
      transcriberModel: agent.transcriberModel,
      transcriberLanguage: agent.transcriberLanguage,
      transcriberEndpointing: agent.transcriberEndpointing,
      llmProvider: agent.llmProvider,
      llmModel: agent.llmModel,
      llmTemperature: agent.llmTemperature,
      voiceProvider: agent.voiceProvider,
      voiceId: agent.voiceId,
      voiceConfig: agent.voiceConfig,
      voicemailMessage: agent.voicemailMessage,
      endCallMessage: agent.endCallMessage,
      endCallPhrases: agent.endCallPhrases,
      clientMessages: agent.clientMessages,
      serverMessages: agent.serverMessages,
      artifactPlan: agent.artifactPlan,
      startSpeakingPlan: agent.startSpeakingPlan,
      stopSpeakingPlan: agent.stopSpeakingPlan,
      compliancePlan: agent.compliancePlan,
      tone: agent.tone,
      personality: agent.personality,
      tools: agent.tools,
      knowledgeSourceIds: agent.knowledgeSourceIds,
      compliance: agent.compliance,
      escalation: agent.escalation,
      maxDurationSec: agent.maxDurationSec,
    };
    try {
      await update.mutateAsync(patch);
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function togglePause() {
    const next = agent.status === "paused" ? "active" : "paused";
    try {
      await update.mutateAsync({ status: next });
      toast.success(next === "paused" ? "Paused" : "Resumed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function runDeploy() {
    if (dirty) {
      toast.error("Save your changes before deploying");
      return;
    }
    if (!agent.voiceId) {
      toast.error("Pick a voice first");
      setTab("Configuration");
      setCfgTab("Voice");
      return;
    }
    try {
      await deploy.mutateAsync();
      toast.success("Deployed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Deploy failed");
    }
  }

  async function runDelete() {
    if (!confirm(`Delete voice agent "${agent.name}"? This cannot be undone.`)) return;
    try {
      await del.mutateAsync(agent.id);
      toast.success("Deleted");
      nav("/voice-agents");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Voice Agents", href: "/voice-agents" }, { label: agent.name }]}
        title={agent.name}
        subtitle={agent.purpose || "No description"}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
              <Mic className="w-3.5 h-3.5 mr-1.5" />
              Test in browser
            </Button>
            <Button variant="outline" size="sm" onClick={togglePause}>
              <Power className="w-3.5 h-3.5 mr-1.5" />
              {agent.status === "paused" ? "Resume" : "Pause"}
            </Button>
            <Button variant="outline" size="sm" onClick={runDeploy} disabled={deploy.isPending}>
              <Rocket className="w-3.5 h-3.5 mr-1.5" />
              {deploy.isPending ? "Deploying…" : "Deploy"}
            </Button>
            <Button size="sm" onClick={save} disabled={!dirty || update.isPending}>
              {update.isPending ? "Saving…" : "Save changes"}
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
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="p-6 space-y-4">
        {tab === "Overview" && <OverviewTab agent={agent} />}
        {tab === "Configuration" && (
          <Card title="Configuration">
            <div className="border-b border-border px-4 pt-3 flex gap-1 flex-wrap">
              {CONFIG_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setCfgTab(t)}
                  className={cn(
                    "px-2.5 py-1.5 text-xs font-medium rounded-t border-b-2 -mb-px",
                    cfgTab === t
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="p-5">
              {cfgTab === "Persona" && <PersonaTab agent={agent} setAgent={setDraft} />}
              {cfgTab === "Prompt" && <PromptTab agent={agent} setAgent={setDraft} />}
              {cfgTab === "Voice" && <VoiceTab agent={agent} setAgent={setDraft} />}
              {cfgTab === "Tools" && <ToolsTab agent={agent} setAgent={setDraft} />}
              {cfgTab === "Knowledge" && <KnowledgeTab agent={agent} setAgent={setDraft} />}
              {cfgTab === "Escalation" && <EscalationTab agent={agent} setAgent={setDraft} />}
              {cfgTab === "Compliance" && <ComplianceTab agent={agent} setAgent={setDraft} />}
              {cfgTab === "Advanced" && <AdvancedTab agent={agent} setAgent={setDraft} />}
            </div>
          </Card>
        )}
        {tab === "Conversations" && <ConversationsTab agentId={agent.id} />}
        {tab === "Monitor" && <MonitorTab agentId={agent.id} />}
        {tab === "Deployment" && (
          <DeploymentTab agent={agent} deployments={data.deployments} onDelete={runDelete} />
        )}
      </div>

      {id && <TestCallDrawer agentId={id} open={testOpen} onOpenChange={setTestOpen} />}
    </div>
  );
}

// ---------- Overview ----------

function OverviewTab({ agent }: { agent: VoiceAgent }) {
  const stats = useVoiceAgentStats(agent.id, 14);
  const totals = stats.data?.totals;
  const avgDuration = useMemo(() => {
    const s = stats.data?.series ?? [];
    const total = s.reduce((acc, d) => acc + d.avgDuration * d.calls, 0);
    const calls = s.reduce((acc, d) => acc + d.calls, 0);
    return calls ? Math.round(total / calls) : 0;
  }, [stats.data]);

  return (
    <>
      <div className="grid grid-cols-4 gap-4">
        <MetricCard
          label="Calls (14d)"
          value={totals?.calls ?? 0}
          accent={agent.status === "active" ? "success" : "default"}
        />
        <MetricCard
          label="Resolution rate"
          value={`${totals?.resolutionRate ?? 0}%`}
          accent="success"
        />
        <MetricCard
          label="Avg duration"
          value={`${Math.floor(avgDuration / 60)}:${(avgDuration % 60).toString().padStart(2, "0")}`}
        />
        <MetricCard label="Phone" value={agent.phoneNumber ?? "—"} />
      </div>
      <Card title="14-day trend">
        <div className="p-4" style={{ width: "100%", height: 220 }}>
          {stats.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <ResponsiveContainer>
              <LineChart data={stats.data?.series ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis yAxisId="l" tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Line
                  yAxisId="l"
                  dataKey="calls"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  name="Calls"
                />
                <Line
                  yAxisId="l"
                  dataKey="ended"
                  stroke="hsl(var(--success))"
                  strokeWidth={2}
                  dot={false}
                  name="Ended"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>
      <Card title="Quick summary">
        <div className="p-5 space-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Purpose:</span>{" "}
            {agent.purpose || <em className="text-muted-foreground">No description</em>}
          </div>
          <div>
            <span className="text-muted-foreground">Voice:</span>{" "}
            {agent.voiceId ? (
              <code className="text-xs">
                {agent.voiceProvider}:{agent.voiceId}
              </code>
            ) : (
              <span className="text-warning">Not configured</span>
            )}
          </div>
          <div>
            <span className="text-muted-foreground">Transcriber:</span>{" "}
            <code className="text-xs">
              {agent.transcriberProvider}:{agent.transcriberModel} ({agent.transcriberLanguage})
            </code>
          </div>
          <div>
            <span className="text-muted-foreground">Model:</span>{" "}
            <code className="text-xs">
              {agent.llmProvider}:{agent.llmModel}
            </code>{" "}
            @ temperature {agent.llmTemperature}
          </div>
          <div>
            <span className="text-muted-foreground">Tools:</span> {agent.tools.length}
          </div>
          <div>
            <span className="text-muted-foreground">Knowledge sources:</span>{" "}
            {agent.knowledgeSourceIds.length}
          </div>
        </div>
      </Card>
    </>
  );
}

function ConversationsTab({ agentId }: { agentId: string }) {
  const calls = useVoiceAgentCalls(agentId, 50);
  return (
    <Card title="Recent calls">
      {calls.isLoading ? (
        <div className="p-5 text-sm text-muted-foreground">Loading…</div>
      ) : !calls.data || calls.data.length === 0 ? (
        <div className="p-5 text-sm text-muted-foreground">
          No calls yet. Once the agent is deployed and receives calls, they'll show up here.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th>Customer</th>
              <th>Duration</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {calls.data.map((c) => (
              <tr key={c.id}>
                <td className="text-xs text-muted-foreground">
                  {new Date(c.startedAt).toLocaleString()}
                </td>
                <td>
                  <span
                    className={cn(
                      "pill",
                      c.status === "ended"
                        ? "bg-muted text-muted-foreground"
                        : c.status === "active"
                          ? "bg-success/15 text-success"
                          : "bg-warning/15 text-warning",
                    )}
                  >
                    {c.status}
                  </span>
                </td>
                <td className="text-xs">{c.customerRef ?? "—"}</td>
                <td className="tabular-nums text-xs">
                  {c.durationSec != null
                    ? `${Math.floor(c.durationSec / 60)}:${(c.durationSec % 60).toString().padStart(2, "0")}`
                    : "—"}
                </td>
                <td className="text-xs text-muted-foreground max-w-[420px] truncate">
                  {c.summary?.overview ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function MonitorTab({ agentId }: { agentId: string }) {
  // Reuse the per-agent calls query and filter in-flight calls client-side.
  // More aggressive polling interval since supervisors watching this tab want
  // sub-5s latency on "someone just called."
  const calls = useVoiceAgentCalls(agentId, 20);
  const active = useMemo(
    () => (calls.data ?? []).filter((c) => c.status === "active"),
    [calls.data],
  );
  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Calls in progress" value={active.length} />
        <MetricCard label="Ended (last 20)" value={(calls.data ?? []).filter((c) => c.status === "ended").length} />
        <MetricCard
          label="Polling"
          value={<span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse-soft" />10s</span>}
        />
      </div>
      <Card title="Live calls">
        {active.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">
            No active calls right now. In-progress calls will appear here within ~10s of connecting.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Call ID</th>
                <th>Started</th>
                <th>Customer</th>
                <th>Running</th>
              </tr>
            </thead>
            <tbody>
              {active.map((c) => (
                <LiveRow key={c.id} id={c.id} startedAt={c.startedAt} customerRef={c.customerRef} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function LiveRow({ id, startedAt, customerRef }: { id: string; startedAt: string; customerRef: string | null }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  void tick;
  return (
    <tr>
      <td className="font-mono text-xs">{id.slice(0, 8)}…</td>
      <td className="text-xs text-muted-foreground">{new Date(startedAt).toLocaleTimeString()}</td>
      <td className="text-xs">{customerRef ?? "—"}</td>
      <td className="tabular-nums text-xs">
        {Math.floor(sec / 60)}:{(sec % 60).toString().padStart(2, "0")}
      </td>
    </tr>
  );
}

// ---------- Config tabs ----------

type SetAgent = React.Dispatch<React.SetStateAction<VoiceAgent | null>>;
const patch = (setAgent: SetAgent, changes: Partial<VoiceAgent>) =>
  setAgent((prev) => (prev ? { ...prev, ...changes } : prev));

function PersonaTab({ agent, setAgent }: { agent: VoiceAgent; setAgent: SetAgent }) {
  const personality = agent.personality ?? {};
  const sliders: Array<{ key: keyof NonNullable<VoiceAgent["personality"]>; label: string }> = [
    { key: "warmth", label: "Warmth" },
    { key: "conciseness", label: "Conciseness" },
    { key: "formality", label: "Formality" },
    { key: "patience", label: "Patience" },
    { key: "proactiveness", label: "Proactiveness" },
  ];
  return (
    <div className="space-y-4 max-w-2xl">
      <LabeledInput
        label="Name"
        value={agent.name}
        onChange={(v) => patch(setAgent, { name: v })}
      />
      <LabeledTextarea
        label="Description"
        value={agent.purpose}
        onChange={(v) => patch(setAgent, { purpose: v })}
      />
      <LabeledTextarea
        label="Opening message"
        value={agent.firstMessage}
        onChange={(v) => patch(setAgent, { firstMessage: v })}
      />
      <LabeledInput
        label="Tone"
        value={agent.tone}
        onChange={(v) => patch(setAgent, { tone: v })}
      />
      <div>
        <label className="text-xs font-medium block mb-1.5">Primary language</label>
        <select
          value={agent.language}
          onChange={(e) =>
            patch(setAgent, {
              language: e.target.value as VoiceAgentLanguage,
              // When the primary language changes, align the transcriber too.
              transcriberLanguage:
                e.target.value === "multi" ? "multi" : e.target.value.split("-")[0],
            })
          }
          className="w-full h-9 border border-border rounded px-2 text-sm bg-background"
        >
          <option value="multi">Hinglish (Hindi + English)</option>
          <option value="hi-IN">Hindi</option>
          <option value="en-IN">Indian English</option>
          <option value="en-US">US English</option>
          <option value="en-GB">UK English</option>
          <option value="mr-IN">Marathi</option>
          <option value="ta-IN">Tamil</option>
          <option value="te-IN">Telugu</option>
        </select>
      </div>
      <div>
        <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-3">
          Personality sliders
        </div>
        {sliders.map((s) => {
          const v = personality[s.key] ?? 50;
          return (
            <div
              key={s.key}
              className="grid grid-cols-[120px_1fr_36px] gap-3 items-center mb-2.5"
            >
              <label className="text-xs">{s.label}</label>
              <input
                type="range"
                min={0}
                max={100}
                value={v}
                onChange={(e) =>
                  patch(setAgent, {
                    personality: { ...personality, [s.key]: Number(e.target.value) },
                  })
                }
                className="w-full accent-primary"
              />
              <span className="text-xs tabular-nums text-muted-foreground">{v}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PromptTab({ agent, setAgent }: { agent: VoiceAgent; setAgent: SetAgent }) {
  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <label className="text-xs font-medium block mb-1.5">System prompt</label>
        <textarea
          value={agent.systemPrompt}
          onChange={(e) => patch(setAgent, { systemPrompt: e.target.value })}
          placeholder="Describe who the agent is, what it knows, what it should do, and what it must never do."
          className="w-full text-sm border border-border rounded p-3 min-h-[280px] font-mono bg-background"
        />
        <div className="text-xs text-muted-foreground mt-1.5">
          {agent.language === "multi"
            ? "Hinglish directive and tone/compliance/escalation sections are appended automatically on deploy — keep the prompt focused on domain knowledge."
            : "Tone/compliance/escalation sections are appended automatically on deploy."}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="text-xs font-medium block mb-1.5">Model</label>
          <select
            value={agent.llmModel}
            onChange={(e) => patch(setAgent, { llmModel: e.target.value })}
            className="w-full h-9 border border-border rounded px-2 text-sm bg-background"
          >
            <option value="gpt-4o">gpt-4o</option>
            <option value="gpt-4o-mini">gpt-4o-mini</option>
            <option value="gpt-4.1">gpt-4.1</option>
            <option value="claude-3-5-sonnet-20241022">claude-3-5-sonnet</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5">
            Temperature ({agent.llmTemperature})
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={agent.llmTemperature}
            onChange={(e) => patch(setAgent, { llmTemperature: Number(e.target.value) })}
            className="w-full accent-primary"
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5">Max duration (sec)</label>
          <Input
            type="number"
            min={30}
            max={3600}
            value={agent.maxDurationSec}
            onChange={(e) => patch(setAgent, { maxDurationSec: Number(e.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}

const VOICE_PROVIDER_OPTIONS = ["11labs", "vapi", "cartesia", "azure", "deepgram"] as const;

function VoiceTab({ agent, setAgent }: { agent: VoiceAgent; setAgent: SetAgent }) {
  const voices = useVapiVoices();
  const [filter, setFilter] = useState<"hindi" | "english" | "all">(
    agent.language === "multi" || agent.language.startsWith("hi") ? "hindi" : "english",
  );
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualProvider, setManualProvider] = useState<string>(agent.voiceProvider || "11labs");
  const [manualId, setManualId] = useState<string>("");

  function playPreview(url: string, key: string) {
    // Stop any existing preview first so users can rapid-click without overlap.
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const audio = new Audio(url);
    audio.crossOrigin = "anonymous";
    audio.onended = () => setNowPlaying((k) => (k === key ? null : k));
    audio.onerror = () => {
      setNowPlaying(null);
      toast.error("Preview failed (CORS or unavailable)");
    };
    audioRef.current = audio;
    setNowPlaying(key);
    audio.play().catch((err: DOMException) => {
      setNowPlaying(null);
      toast.error(
        err.name === "NotAllowedError"
          ? "Browser blocked autoplay — click again after interacting."
          : "Preview failed",
      );
    });
  }

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const filtered = useMemo(() => {
    const list = voices.data ?? [];
    if (filter === "all") return list;
    // Voice catalog entries don't always carry a language field, so when a
    // language filter produces nothing we fall back to the full list rather
    // than showing an empty grid.
    const narrowed =
      filter === "hindi"
        ? list.filter(
            (v) =>
              (v.language ?? "").toLowerCase().startsWith("hi") ||
              (v.language ?? "").toLowerCase() === "multi" ||
              /hind/i.test(v.name) ||
              /multi/i.test(v.name),
          )
        : list.filter((v) => (v.language ?? "").toLowerCase().startsWith("en"));
    return narrowed.length ? narrowed : list;
  }, [voices.data, filter]);

  function pick(v: VapiVoiceOption) {
    patch(setAgent, { voiceProvider: v.provider, voiceId: v.voiceId });
  }

  function applyManual() {
    const id = manualId.trim();
    if (!id) {
      toast.error("Paste a voice ID first");
      return;
    }
    patch(setAgent, { voiceProvider: manualProvider, voiceId: id });
    toast.success(`Voice set to ${manualProvider}:${id}`);
    setManualId("");
    setManualOpen(false);
  }

  const hasCurrent = !!agent.voiceId;

  return (
    <div className="space-y-4">
      {/* Current voice — always shown so the selected ID is visible even when
          it isn't in the library catalog (e.g. a custom / org-scoped voice). */}
      <div
        className={cn(
          "flex items-center gap-3 p-3 rounded border",
          hasCurrent ? "border-primary bg-primary-muted/30" : "border-dashed border-border",
        )}
      >
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
          Current voice
        </span>
        {hasCurrent ? (
          <>
            <code className="text-xs flex-1 truncate">
              {agent.voiceProvider}:{agent.voiceId}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => patch(setAgent, { voiceId: "" })}
              className="h-7"
            >
              Clear
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground italic">
            None selected. Pick from the library below or paste a voice ID manually.
          </span>
        )}
      </div>

      {/* Manual voice ID — for custom / org-scoped voices that don't appear
          in the public voice library (e.g. cloned voices on ElevenLabs). */}
      <div className="border border-border rounded">
        <button
          onClick={() => setManualOpen((v) => !v)}
          className="w-full flex items-center justify-between p-3 text-left text-sm hover:bg-muted/40"
        >
          <span>
            <span className="font-medium">Paste a voice ID manually</span>
            <span className="text-xs text-muted-foreground ml-2">
              Use this if the voice you need (e.g. an ElevenLabs custom voice) isn't listed below.
            </span>
          </span>
          <span className="text-xs text-muted-foreground">{manualOpen ? "−" : "+"}</span>
        </button>
        {manualOpen && (
          <div className="p-3 pt-0 grid grid-cols-[160px_1fr_auto] gap-2 items-end">
            <div>
              <label className="text-[11px] text-muted-foreground block mb-1">Provider</label>
              <select
                value={manualProvider}
                onChange={(e) => setManualProvider(e.target.value)}
                className="w-full h-9 border border-border rounded px-2 text-sm bg-background"
              >
                {VOICE_PROVIDER_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground block mb-1">Voice ID</label>
              <Input
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                placeholder="e.g. 90ipbRoKi4CpHXvKVtl0"
                className="h-9 font-mono text-xs"
              />
            </div>
            <Button size="sm" onClick={applyManual} className="h-9">
              Use this voice
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Filter:</span>
        {(["hindi", "english", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-2 py-1 text-xs rounded capitalize",
              filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>
      {voices.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading voices…</div>
      ) : voices.error ? (
        <div className="text-sm text-destructive">
          Could not load voices. Check that the voice provider is configured on the backend.
        </div>
      ) : !filtered.length ? (
        <div className="text-sm text-muted-foreground">
          No voices in the library — use "Paste a voice ID manually" above.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 max-h-[480px] overflow-y-auto pr-1">
          {filtered.map((v) => {
            const isCurrent = v.provider === agent.voiceProvider && v.voiceId === agent.voiceId;
            return (
              <button
                key={`${v.provider}:${v.voiceId}`}
                onClick={() => pick(v)}
                className={cn(
                  "flex items-center gap-2 p-3 border rounded text-left text-sm hover:bg-muted/40",
                  isCurrent ? "border-primary bg-primary-muted/40" : "border-border",
                )}
              >
                {v.previewUrl ? (
                  <span
                    role="button"
                    aria-label="Preview voice"
                    onClick={(e) => {
                      e.stopPropagation();
                      playPreview(v.previewUrl!, `${v.provider}:${v.voiceId}`);
                    }}
                    className={cn(
                      "w-7 h-7 shrink-0 rounded-full text-primary-foreground inline-flex items-center justify-center cursor-pointer",
                      nowPlaying === `${v.provider}:${v.voiceId}`
                        ? "bg-success animate-pulse-soft"
                        : "bg-primary",
                    )}
                  >
                    <Play className="w-3 h-3" />
                  </span>
                ) : null}
                <span className="flex-1 min-w-0">
                  <div className="font-medium truncate">{v.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {v.provider}
                    {v.language ? ` · ${v.language}` : ""}
                    {v.gender ? ` · ${v.gender}` : ""}
                    {v.accent ? ` · ${v.accent}` : ""}
                  </div>
                </span>
                {isCurrent && (
                  <span className="text-[10px] text-primary font-semibold">Current</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ToolsTab({ agent, setAgent }: { agent: VoiceAgent; setAgent: SetAgent }) {
  // Local draft of parameter JSON text per tool — keeps the textarea editable
  // while the user types invalid JSON (state only flips back to agent.tools
  // when JSON parses cleanly).
  const [paramDrafts, setParamDrafts] = useState<Record<number, string>>({});
  const [paramErrors, setParamErrors] = useState<Record<number, string>>({});

  function addTool() {
    const next: VoiceAgentTool = {
      name: "new_tool",
      description: "Describe what this tool does.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      fulfillmentUrl: "",
    };
    patch(setAgent, { tools: [...agent.tools, next] });
  }

  function updateTool(idx: number, changes: Partial<VoiceAgentTool>) {
    const next = agent.tools.slice();
    next[idx] = { ...next[idx], ...changes };
    patch(setAgent, { tools: next });
  }

  function removeTool(idx: number) {
    patch(setAgent, { tools: agent.tools.filter((_, i) => i !== idx) });
    setParamDrafts((d) => {
      const { [idx]: _, ...rest } = d;
      return rest;
    });
    setParamErrors((d) => {
      const { [idx]: _, ...rest } = d;
      return rest;
    });
  }

  function onParamsChange(idx: number, text: string) {
    setParamDrafts((d) => ({ ...d, [idx]: text }));
    try {
      const parsed = JSON.parse(text);
      const validationErr = validateParameterSchema(parsed);
      if (validationErr) {
        setParamErrors((d) => ({ ...d, [idx]: validationErr }));
        return;
      }
      setParamErrors((d) => {
        const { [idx]: _, ...rest } = d;
        return rest;
      });
      updateTool(idx, { parameters: parsed });
    } catch (err) {
      setParamErrors((d) => ({
        ...d,
        [idx]: err instanceof Error ? err.message : "Invalid JSON",
      }));
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Tools let the agent take actions mid-call. The agent sees the description + parameter schema
        and, when it decides to invoke a tool, the voice agent POSTs to your fulfillment URL with the
        parsed parameters.
      </p>
      {agent.tools.length === 0 && (
        <div className="text-sm text-muted-foreground italic p-4 border border-dashed border-border rounded">
          No tools yet. Add one below.
        </div>
      )}
      {agent.tools.map((t, i) => {
        const nameInvalid = !TOOL_NAME_RE.test(t.name);
        const urlInvalid =
          !!t.fulfillmentUrl &&
          !t.fulfillmentUrl.startsWith("http://") &&
          !t.fulfillmentUrl.startsWith("https://");
        const paramsText = paramDrafts[i] ?? JSON.stringify(t.parameters, null, 2);
        const paramErr = paramErrors[i];
        return (
          <div key={i} className="border border-border rounded p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex-1">
                <Input
                  value={t.name}
                  onChange={(e) => updateTool(i, { name: e.target.value })}
                  placeholder="tool_name"
                  className={cn(
                    "max-w-xs font-mono h-8",
                    nameInvalid && "border-destructive",
                  )}
                />
                {nameInvalid && (
                  <div className="text-[11px] text-destructive mt-1">
                    Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/
                  </div>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => removeTool(i)}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
            <Input
              value={t.description}
              onChange={(e) => updateTool(i, { description: e.target.value })}
              placeholder="Description shown to the model"
              className="h-8"
            />
            <div>
              <Input
                value={t.fulfillmentUrl ?? ""}
                onChange={(e) => updateTool(i, { fulfillmentUrl: e.target.value })}
                placeholder="https://your-backend/tools/this-tool"
                className={cn("h-8 font-mono text-xs", urlInvalid && "border-destructive")}
              />
              {urlInvalid && (
                <div className="text-[11px] text-destructive mt-1">
                  Must start with http:// or https://
                </div>
              )}
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Parameters (JSON schema)
              </label>
              <textarea
                value={paramsText}
                onChange={(e) => onParamsChange(i, e.target.value)}
                className={cn(
                  "w-full font-mono text-xs border rounded p-2 min-h-[120px] bg-background",
                  paramErr ? "border-destructive" : "border-border",
                )}
              />
              {paramErr && (
                <div className="text-[11px] text-destructive mt-1">{paramErr}</div>
              )}
            </div>
          </div>
        );
      })}
      <Button variant="outline" size="sm" onClick={addTool}>
        <Plus className="w-3.5 h-3.5 mr-1.5" />
        Add tool
      </Button>
    </div>
  );
}

function validateParameterSchema(schema: unknown): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return 'Root must be an object (e.g. { "type": "object", "properties": {} })';
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== "object") return 'Root "type" must be "object"';
  if (s.properties !== undefined && (typeof s.properties !== "object" || Array.isArray(s.properties))) {
    return '"properties" must be an object';
  }
  if (s.required !== undefined && !Array.isArray(s.required)) {
    return '"required" must be an array of strings';
  }
  if (Array.isArray(s.required) && !s.required.every((r) => typeof r === "string")) {
    return '"required" must contain only strings';
  }
  return null;
}

function KnowledgeTab({ agent, setAgent }: { agent: VoiceAgent; setAgent: SetAgent }) {
  const sources = useKbSources();
  const selected = new Set(agent.knowledgeSourceIds);

  function toggle(id: string) {
    const next = selected.has(id)
      ? agent.knowledgeSourceIds.filter((x) => x !== id)
      : [...agent.knowledgeSourceIds, id];
    patch(setAgent, { knowledgeSourceIds: next });
  }

  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Select knowledge sources the agent can retrieve from during calls.
      </p>
      {sources.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading sources…</div>
      ) : sources.error ? (
        <div className="text-sm text-destructive">Failed to load knowledge sources.</div>
      ) : !sources.data || sources.data.length === 0 ? (
        <div className="text-sm text-muted-foreground italic p-4 border border-dashed border-border rounded">
          No knowledge sources yet. Create one at{" "}
          <a href="/knowledge" className="text-primary underline">
            /knowledge
          </a>
          .
        </div>
      ) : (
        <div className="space-y-1.5">
          {sources.data.map((s) => {
            const checked = selected.has(s.id);
            return (
              <label
                key={s.id}
                className={cn(
                  "flex items-center gap-3 border rounded p-3 cursor-pointer hover:bg-muted/40",
                  checked ? "border-primary bg-primary-muted/40" : "border-border",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(s.id)}
                  className="accent-primary"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.type} · {s.status} · {s.documentCount} docs
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
      {agent.knowledgeSourceIds.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {agent.knowledgeSourceIds.length} selected
        </div>
      )}
    </div>
  );
}

function EscalationTab({ agent, setAgent }: { agent: VoiceAgent; setAgent: SetAgent }) {
  const rules = agent.escalation?.rules ?? [];
  const handoff = agent.escalation?.handoffPhone ?? "";
  function setRules(next: string[]) {
    patch(setAgent, { escalation: { ...(agent.escalation ?? {}), rules: next } });
  }
  return (
    <div className="space-y-4 max-w-2xl">
      <LabeledInput
        label="Handoff phone (E.164)"
        value={handoff}
        onChange={(v) => patch(setAgent, { escalation: { ...(agent.escalation ?? {}), handoffPhone: v } })}
        placeholder="+911234567890"
      />
      <div>
        <label className="text-xs font-medium block mb-1.5">Rules</label>
        <div className="space-y-2">
          {rules.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={r}
                onChange={(e) => {
                  const next = rules.slice();
                  next[i] = e.target.value;
                  setRules(next);
                }}
                className="h-8"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRules(rules.filter((_, j) => j !== i))}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRules([...rules, ""])}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add rule
          </Button>
        </div>
      </div>
    </div>
  );
}

function ComplianceTab({ agent, setAgent }: { agent: VoiceAgent; setAgent: SetAgent }) {
  const c = agent.compliance ?? {};
  const set = (changes: Partial<VoiceAgent["compliance"] & object>) =>
    patch(setAgent, { compliance: { ...c, ...changes } });
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <label className="text-xs font-medium block mb-1.5">Required disclosures (one per line)</label>
        <textarea
          value={(c.disclosures ?? []).join("\n")}
          onChange={(e) =>
            set({ disclosures: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })
          }
          className="w-full text-sm border border-border rounded p-2 min-h-[100px] bg-background"
          placeholder="This call may be recorded for quality purposes."
        />
      </div>
      <div>
        <label className="text-xs font-medium block mb-1.5">Prohibited statements (one per line)</label>
        <textarea
          value={(c.prohibited ?? []).join("\n")}
          onChange={(e) =>
            set({ prohibited: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })
          }
          className="w-full text-sm border border-border rounded p-2 min-h-[100px] bg-background"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!c.piiRedaction}
          onChange={(e) => set({ piiRedaction: e.target.checked })}
        />
        Redact PII (card numbers, Aadhaar, PAN) in stored transcripts
      </label>
    </div>
  );
}

function AdvancedTab({ agent, setAgent }: { agent: VoiceAgent; setAgent: SetAgent }) {
  const vc = agent.voiceConfig ?? {};
  const cp = agent.compliancePlan ?? {};
  const setVoiceCfg = (changes: Partial<NonNullable<VoiceAgent["voiceConfig"]>>) =>
    patch(setAgent, { voiceConfig: { ...(agent.voiceConfig ?? {}), ...changes } });

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
          Call scripts
        </div>
        <div className="space-y-3">
          <LabeledTextarea
            label="Voicemail message (played if the call hits voicemail)"
            value={agent.voicemailMessage ?? ""}
            onChange={(v) => patch(setAgent, { voicemailMessage: v || null })}
          />
          <LabeledTextarea
            label="End-call message (played right before hang-up)"
            value={agent.endCallMessage ?? ""}
            onChange={(v) => patch(setAgent, { endCallMessage: v || null })}
          />
          <div>
            <label className="text-xs font-medium block mb-1.5">
              End-call phrases (one per line — when the caller says one of these, the agent hangs up)
            </label>
            <textarea
              value={agent.endCallPhrases.join("\n")}
              onChange={(e) =>
                patch(setAgent, {
                  endCallPhrases: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                })
              }
              className="w-full text-sm border border-border rounded p-2 min-h-[80px] bg-background"
              placeholder={"goodbye\ntalk to you soon"}
            />
          </div>
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
          Voice tuning (ElevenLabs)
        </div>
        <div className="grid grid-cols-2 gap-3">
          <LabeledInput
            label="Voice model"
            value={vc.model ?? ""}
            onChange={(v) => setVoiceCfg({ model: v || undefined })}
            placeholder="eleven_multilingual_v2"
          />
          <LabeledNumber
            label={`Speed (${vc.speed ?? 1})`}
            value={vc.speed ?? 1}
            min={0.5}
            max={2}
            step={0.05}
            onChange={(v) => setVoiceCfg({ speed: v })}
          />
          <LabeledNumber
            label={`Stability (${vc.stability ?? 0.5})`}
            value={vc.stability ?? 0.5}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => setVoiceCfg({ stability: v })}
          />
          <LabeledNumber
            label={`Similarity boost (${vc.similarityBoost ?? 0.75})`}
            value={vc.similarityBoost ?? 0.75}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => setVoiceCfg({ similarityBoost: v })}
          />
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
          Transcriber tuning
        </div>
        <LabeledNumber
          label={`Endpointing (ms of silence before the user turn ends) — ${agent.transcriberEndpointing ?? "default"}`}
          value={agent.transcriberEndpointing ?? 150}
          min={0}
          max={5000}
          step={10}
          onChange={(v) => patch(setAgent, { transcriberEndpointing: v })}
        />
      </div>

      <div>
        <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
          Compliance plan
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!cp.hipaaEnabled}
            onChange={(e) =>
              patch(setAgent, {
                compliancePlan: { ...(agent.compliancePlan ?? {}), hipaaEnabled: e.target.checked },
              })
            }
          />
          HIPAA-compliant logging
        </label>
        <label className="flex items-center gap-2 text-sm mt-1">
          <input
            type="checkbox"
            checked={!!cp.pciEnabled}
            onChange={(e) =>
              patch(setAgent, {
                compliancePlan: { ...(agent.compliancePlan ?? {}), pciEnabled: e.target.checked },
              })
            }
          />
          PCI-compliant logging
        </label>
      </div>

      <div>
        <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
          Event subscriptions
        </div>
        <div className="grid grid-cols-2 gap-3">
          <JsonArrayField
            label="Client messages (sent to browser SDK)"
            value={agent.clientMessages}
            onChange={(next) => patch(setAgent, { clientMessages: next })}
          />
          <JsonArrayField
            label="Server messages (sent to webhook)"
            value={agent.serverMessages}
            onChange={(next) => patch(setAgent, { serverMessages: next })}
          />
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
          Advanced plans (raw JSON)
        </div>
        <div className="grid grid-cols-1 gap-3">
          <JsonObjectField
            label="startSpeakingPlan"
            value={agent.startSpeakingPlan}
            onChange={(next) => patch(setAgent, { startSpeakingPlan: next })}
          />
          <JsonObjectField
            label="artifactPlan"
            value={agent.artifactPlan}
            onChange={(next) => patch(setAgent, { artifactPlan: next })}
          />
          <JsonObjectField
            label="stopSpeakingPlan"
            value={agent.stopSpeakingPlan}
            onChange={(next) => patch(setAgent, { stopSpeakingPlan: next })}
          />
        </div>
      </div>
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1.5">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}

function JsonArrayField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1.5">{label}</label>
      <textarea
        value={value.join("\n")}
        onChange={(e) =>
          onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))
        }
        className="w-full text-xs border border-border rounded p-2 min-h-[80px] bg-background font-mono"
        placeholder={"one\nper\nline"}
      />
    </div>
  );
}

function JsonObjectField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Record<string, unknown> | null;
  onChange: (next: Record<string, unknown> | null) => void;
}) {
  const [draft, setDraft] = useState<string>(() => (value ? JSON.stringify(value, null, 2) : ""));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value ? JSON.stringify(value, null, 2) : "");
    setErr(null);
  }, [value]);
  return (
    <div>
      <label className="text-xs font-medium block mb-1.5">{label}</label>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const text = e.target.value.trim();
          if (!text) {
            setErr(null);
            onChange(null);
            return;
          }
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              setErr(null);
              onChange(parsed as Record<string, unknown>);
            } else {
              setErr("Must be a JSON object");
            }
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : "Invalid JSON");
          }
        }}
        className={cn(
          "w-full text-xs border rounded p-2 min-h-[100px] bg-background font-mono",
          err ? "border-destructive" : "border-border",
        )}
        placeholder="{}"
      />
      {err && <div className="text-[11px] text-destructive mt-1">{err}</div>}
    </div>
  );
}

// ---------- Deployment ----------

function DeploymentTab({
  agent,
  deployments,
  onDelete,
}: {
  agent: VoiceAgent;
  deployments: { id: string; deployedAt: string; status: "success" | "failed"; errorMessage: string | null }[];
  onDelete: () => void;
}) {
  return (
    <>
      <Card title="Deployment configuration">
        <div className="p-5 grid grid-cols-2 gap-x-6 gap-y-4 max-w-3xl">
          <ReadOnly label="Phone number" value={agent.phoneNumber ?? "Not yet assigned"} />
          <ReadOnly
            label="Assistant ID"
            value={agent.vapiAssistantId ?? "Not yet deployed"}
            mono
          />
          <ReadOnly label="Status" value={agent.status} />
          <ReadOnly
            label="Last deployed"
            value={agent.lastDeployedAt ? new Date(agent.lastDeployedAt).toLocaleString() : "never"}
          />
          <ReadOnly
            label="Language"
            value={agent.language === "multi" ? "Hinglish (multilingual)" : agent.language}
          />
          <ReadOnly
            label="Transcriber"
            value={`${agent.transcriberProvider}/${agent.transcriberModel} (${agent.transcriberLanguage})`}
            mono
          />
        </div>
      </Card>
      <Card title="Deployment history">
        {deployments.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">No deployments yet.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Deployed</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <td className="text-xs text-muted-foreground">
                    {new Date(d.deployedAt).toLocaleString()}
                  </td>
                  <td>
                    <span
                      className={cn(
                        "pill",
                        d.status === "success"
                          ? "bg-success/15 text-success"
                          : "bg-destructive/15 text-destructive",
                      )}
                    >
                      {d.status === "success" ? (
                        <CheckCircle2 className="w-3 h-3 inline mr-1" />
                      ) : (
                        <AlertTriangle className="w-3 h-3 inline mr-1" />
                      )}
                      {d.status}
                    </span>
                  </td>
                  <td className="text-xs text-muted-foreground">{d.errorMessage ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Danger zone">
        <div className="p-5 flex items-center justify-between">
          <div className="text-sm">
            <div className="font-medium">Delete this voice agent</div>
            <div className="text-xs text-muted-foreground">
              This detaches the deployed assistant and removes all local config. Call history is kept.
            </div>
          </div>
          <Button variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Delete
          </Button>
        </div>
      </Card>
    </>
  );
}

// ---------- small UI helpers ----------

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1.5">{label}</label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function LabeledTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1.5">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm border border-border rounded p-2 min-h-[60px] bg-background"
      />
    </div>
  );
}

function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">{label}</label>
      <div className={cn("text-sm", mono && "font-mono text-xs")}>{value}</div>
    </div>
  );
}

void Phone;
