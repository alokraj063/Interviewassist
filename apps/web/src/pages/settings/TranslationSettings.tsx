import { Languages, Save, Mic, BookOpen, ShieldCheck, Info, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useTranslationApi } from "@/hooks/useTranslationApi";
import {
  LANGUAGE_CATALOG,
  MOCK_GLOSSARIES,
  PROVIDER_LABELS,
  PROVIDER_STATUS,
  type LowConfidenceAction,
  type SupportedLanguage,
  type TranslationLatencyMode,
  type TranslationProvider,
} from "@/lib/translationConfig";

const PROVIDER_MODELS: Record<TranslationProvider, Array<{ id: string; label: string }>> = {
  mock: [
    { id: "mock-v1", label: "Mock v1 (fixture replay)", },
  ],
  openai: [
    { id: "gpt-4o", label: "GPT-4o (accurate)" },
    { id: "gpt-4o-mini", label: "GPT-4o mini (balanced/fast)" },
  ],
  google: [
    { id: "gemini-translate-v2", label: "Gemini Translate v2 (default)" },
    { id: "translate-nmt-lite", label: "Translate NMT Lite" },
  ],
  deepl: [
    { id: "deepl-next", label: "DeepL Next" },
    { id: "deepl-classic", label: "DeepL Classic" },
  ],
  azure: [
    { id: "azure-translator-v3", label: "Azure Translator v3" },
    { id: "azure-translator-fast", label: "Azure Translator Fast" },
  ],
  sarvam: [
    { id: "sarvam-indic-v1", label: "Sarvam Indic v1" },
    { id: "sarvam-indic-mini", label: "Sarvam Indic Mini" },
  ],
};

export default function TranslationSettings() {
  const { settings, updateLocal: update, save: apiSave, reset, source, saving } =
    useTranslationApi();

  async function save() {
    const ok = await apiSave();
    if (ok) {
      toast.success("Translation settings saved", {
        description: "Synced to the workspace. All calls in this org use these defaults.",
      });
    } else {
      toast.error("Save failed", {
        description: "Kept your changes locally — retry when the server is reachable.",
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Languages className="w-4.5 h-4.5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Live translation</h2>
            <p className="text-sm text-muted-foreground">
              Provider, voice, and quality controls for real-time translation during calls.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              "text-[11px] px-2 py-0.5 rounded-full border",
              source === "api"
                ? "border-success/40 bg-success/10 text-success"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
            title={
              source === "api"
                ? "Settings loaded from the workspace."
                : "Using local cache — server unreachable. Saves will retry."
            }
          >
            {source === "api" ? "Synced" : "Local only"}
          </span>
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Reset
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="quality">Quality &amp; Voice</TabsTrigger>
          <TabsTrigger value="glossary">Glossary &amp; Redaction</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4">
          <Card title="Provider">
            <div className="p-5 space-y-4 max-w-2xl">
              <FieldRow
                label="Translation provider"
                hint="Routes both text translation and (in bidirectional mode) voice synthesis."
              >
                <Select
                  value={settings.provider}
                  onValueChange={(v) => {
                    const provider = v as TranslationProvider;
                    const firstModel = PROVIDER_MODELS[provider][0]?.id ?? "";
                    update({ provider, model: firstModel });
                  }}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PROVIDER_LABELS).map(([id, label]) => {
                      const status = PROVIDER_STATUS[id as TranslationProvider];
                      return (
                        <SelectItem key={id} value={id}>
                          <span className="inline-flex items-center gap-2">
                            {label}
                            {status === "stub" && (
                              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                · stub
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </FieldRow>

              <FieldRow label="Model" hint="Larger models translate more naturally; smaller ones are faster.">
                <Select value={settings.model} onValueChange={(v) => update({ model: v })}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(PROVIDER_MODELS[settings.provider] ?? []).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
          </Card>

          <Card title="Default languages">
            <div className="p-5 space-y-4 max-w-2xl">
              <FieldRow
                label="Default caller language"
                hint="Used as a hint when auto-detect is off, or as a fallback when detection is low-confidence."
              >
                <Select
                  value={settings.defaultSourceLang}
                  onValueChange={(v) =>
                    update({ defaultSourceLang: v as SupportedLanguage | "auto" })
                  }
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">🌐 Auto-detect</SelectItem>
                    {LANGUAGE_CATALOG.filter((l) => l.code !== "multi").map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.flag} {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>

              <FieldRow label="Default agent language" hint="The language agents see and speak by default.">
                <Select
                  value={settings.defaultTargetLang}
                  onValueChange={(v) => update({ defaultTargetLang: v as SupportedLanguage })}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_CATALOG.filter((l) => l.code !== "multi").map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.flag} {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>

              <ToggleRow
                label="Auto-detect caller language"
                hint="Listen to the first 2–3 seconds of audio and pick the most likely language."
                value={settings.autoDetect}
                onChange={(v) => update({ autoDetect: v })}
              />
            </div>
          </Card>

          <Card title="Latency">
            <div className="p-5 max-w-2xl">
              <RadioGroup
                value={settings.latencyMode}
                onValueChange={(v) => update({ latencyMode: v as TranslationLatencyMode })}
                className="grid grid-cols-3 gap-3"
              >
                <LatencyOption
                  id="lat-realtime"
                  value="realtime"
                  title="Realtime"
                  hint="~200ms, may sacrifice nuance"
                  active={settings.latencyMode === "realtime"}
                />
                <LatencyOption
                  id="lat-balanced"
                  value="balanced"
                  title="Balanced"
                  hint="~400ms, best everyday default"
                  active={settings.latencyMode === "balanced"}
                />
                <LatencyOption
                  id="lat-accurate"
                  value="accurate"
                  title="Accurate"
                  hint="~800ms, highest quality"
                  active={settings.latencyMode === "accurate"}
                />
              </RadioGroup>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="quality" className="space-y-4">
          <Card title="Voice translation (outbound)">
            <div className="p-5 space-y-4 max-w-2xl">
              <ToggleRow
                label="Preserve speaker tone"
                hint="Match the agent's pacing, emphasis, and emotion when synthesising the caller's language."
                value={settings.preserveTone}
                onChange={(v) => update({ preserveTone: v })}
              />
              <ToggleRow
                label="Clone agent voice"
                hint="Use ElevenLabs voice cloning so the caller hears a voice that sounds like the agent."
                value={settings.voiceCloning}
                onChange={(v) => update({ voiceCloning: v })}
              />
              {settings.voiceCloning && (
                <Alert>
                  <Mic className="w-4 h-4" />
                  <AlertTitle>Consent required</AlertTitle>
                  <AlertDescription className="text-xs">
                    Voice cloning requires a one-time enrolment and agent consent recording. Phase 2
                    will walk agents through enrolment automatically.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </Card>

          <Card title="Confidence">
            <div className="p-5 space-y-4 max-w-2xl">
              <div>
                <Label className="text-xs font-medium">
                  Confidence threshold ·{" "}
                  <span className="tabular-nums">{Math.round(settings.confidenceThreshold * 100)}%</span>
                </Label>
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-3">
                  Translations below this score trigger the low-confidence action.
                </p>
                <Slider
                  value={[settings.confidenceThreshold]}
                  min={0.3}
                  max={0.95}
                  step={0.05}
                  onValueChange={(v) => update({ confidenceThreshold: v[0] ?? 0.6 })}
                />
              </div>

              <FieldRow
                label="Low-confidence action"
                hint="What to do when the model isn't sure about a translation."
              >
                <Select
                  value={settings.lowConfidenceAction}
                  onValueChange={(v) => update({ lowConfidenceAction: v as LowConfidenceAction })}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="show-warning">Show warning badge on bubble</SelectItem>
                    <SelectItem value="insert-original">Insert original text as fallback</SelectItem>
                    <SelectItem value="drop">Drop the translation (agent sees original only)</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="glossary" className="space-y-4">
          <Card title="Glossary">
            <div className="p-5 space-y-4 max-w-2xl">
              <FieldRow
                label="Active glossary"
                hint="Custom term mappings (e.g. product names, legal phrasing) that should not be translated or should translate in a specific way."
              >
                <Select
                  value={settings.glossaryId ?? "__none__"}
                  onValueChange={(v) => update({ glossaryId: v === "__none__" ? null : v })}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No glossary</SelectItem>
                    {MOCK_GLOSSARIES.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>

              <div>
                <Label className="text-xs font-medium">Custom phrase mappings</Label>
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-1.5">
                  One per line. Format: <code className="font-mono text-[10px]">source → translation</code>.
                  Leave blank to skip.
                </p>
                <Textarea
                  value={settings.customPhrases}
                  onChange={(e) => update({ customPhrases: e.target.value })}
                  rows={5}
                  placeholder={"HP Pavilion → HP Pavilion\nBIOS → BIOS\nJoules to Watts → Joules to Watts"}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </Card>

          <Card title="Privacy &amp; redaction">
            <div className="p-5 space-y-4 max-w-2xl">
              <ToggleRow
                label="Redact PII before translating"
                hint="Mask names, phone numbers, emails, and account IDs before sending to the provider. Re-inserted into the final translation."
                value={settings.redactPII}
                onChange={(v) => update({ redactPII: v })}
              />
              <ToggleRow
                label="Profanity filter"
                hint="Replace profanity with asterisks in the translated output."
                value={settings.profanityFilter}
                onChange={(v) => update({ profanityFilter: v })}
              />
              <Alert>
                <ShieldCheck className="w-4 h-4" />
                <AlertTitle>Data handling</AlertTitle>
                <AlertDescription className="text-xs">
                  Translation requests inherit your workspace data-residency settings. Transcripts
                  are retained per your compliance policy in{" "}
                  <a href="/settings/compliance" className="text-primary hover:underline">
                    Compliance &amp; Data
                  </a>
                  .
                </AlertDescription>
              </Alert>
            </div>
          </Card>
        </TabsContent>
      </Tabs>

      <Alert className="max-w-3xl">
        <Info className="w-4 h-4" />
        <AlertTitle>Provider coverage</AlertTitle>
        <AlertDescription className="text-xs">
          Today <span className="font-medium">mock</span> and{" "}
          <span className="font-medium">openai</span> are live. The remaining providers are
          stubbed and will 501 at runtime until their adapters land. Use mock for deterministic
          demos, openai for free-form scenarios.
        </AlertDescription>
      </Alert>
    </div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-xs font-medium">{label}</Label>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5 mb-1.5">{hint}</p>}
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border border-border rounded-md p-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

function LatencyOption({
  id,
  value,
  title,
  hint,
  active,
}: {
  id: string;
  value: string;
  title: string;
  hint: string;
  active: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "border rounded-md p-3 cursor-pointer flex items-start gap-2 transition-colors",
        active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30",
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
    </label>
  );
}

// Silence unused-import warnings for icons retained for future variants.
void BookOpen;
