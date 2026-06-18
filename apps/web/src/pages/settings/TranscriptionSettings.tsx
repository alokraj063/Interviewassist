import { Mic, RotateCcw, Save, Info, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useTranscriptionSettings } from "@/hooks/useTranscriptionSettings";
import {
  TRANSCRIPTION_LANGUAGES,
  TRANSCRIPTION_MODELS,
  TRANSCRIPTION_PROVIDER_DESCRIPTIONS,
  TRANSCRIPTION_PROVIDER_LABELS,
  firstModelFor,
  type TranscriptionLanguage,
  type TranscriptionProvider,
} from "@/lib/transcriptionConfig";

const PROVIDER_DOCS: Record<TranscriptionProvider, { url: string; label: string }> = {
  deepgram: { url: "https://developers.deepgram.com/docs/live-streaming-audio", label: "Deepgram Live Streaming" },
  sarvam: {
    url: "https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api",
    label: "Sarvam STT Streaming",
  },
  shunya: { url: "https://docs.shunyalabs.ai/streaming/overview", label: "Shunya Labs Streaming" },
};

const PROVIDER_KEY_HINTS: Record<TranscriptionProvider, string> = {
  deepgram: "DEEPGRAM_API_KEY",
  sarvam: "SARVAM_API_SUBSCRIPTION_KEY",
  shunya: "SHUNYA_API_KEY",
};

export default function TranscriptionSettings() {
  const [settings, update, reset] = useTranscriptionSettings();

  function save() {
    toast.success("Transcription provider saved", {
      description:
        "Applies to the next test call. Switch providers any time to A/B test on identical call scripts.",
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Mic className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Transcription (STT)</h2>
            <p className="text-sm text-muted-foreground">
              Pick which speech-to-text provider drives the Live Assist test call.
              Switch freely to compare Hinglish accuracy and latency across vendors.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Reset
          </Button>
          <Button size="sm" onClick={save}>
            <Save className="w-3.5 h-3.5 mr-1.5" />
            Save changes
          </Button>
        </div>
      </div>

      <Alert>
        <Info className="w-4 h-4" />
        <AlertTitle>Deepgram routes natively through Vapi. Sarvam &amp; Shunya use a backend bridge.</AlertTitle>
        <AlertDescription>
          When a non-Deepgram provider is selected, the Vapi assistant is configured with
          <code className="mx-1 px-1 rounded bg-muted text-[11px]">provider: custom-transcriber</code>
          which opens a WebSocket to our API, which forwards audio upstream and returns
          transcripts in Vapi's expected shape. API keys are read from the API server's
          environment — no keys are stored in the browser.
        </AlertDescription>
      </Alert>

      <Card title="Provider">
        <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          {(Object.keys(TRANSCRIPTION_PROVIDER_LABELS) as TranscriptionProvider[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => update({ provider: p, model: firstModelFor(p) })}
              className={cn(
                "text-left border rounded-md p-3 transition-colors",
                settings.provider === p
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/40",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{TRANSCRIPTION_PROVIDER_LABELS[p]}</span>
                {settings.provider === p && (
                  <span className="pill bg-primary/15 text-primary text-[10px] px-1.5 py-0.5">
                    Active
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground leading-snug">
                {TRANSCRIPTION_PROVIDER_DESCRIPTIONS[p]}
              </p>
              <div className="mt-2 text-[10px] text-muted-foreground font-mono">
                Env: {PROVIDER_KEY_HINTS[p]}
              </div>
              <a
                href={PROVIDER_DOCS[p].url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                {PROVIDER_DOCS[p].label}
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </button>
          ))}
        </div>
      </Card>

      <Card title="Model & language">
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
          <div>
            <Label className="text-xs text-muted-foreground">Model</Label>
            <Select value={settings.model} onValueChange={(v) => update({ model: v })}>
              <SelectTrigger className="h-9 mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSCRIPTION_MODELS[settings.provider].map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                    {m.hint ? ` — ${m.hint}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Language</Label>
            <Select
              value={settings.language}
              onValueChange={(v) => update({ language: v as TranscriptionLanguage })}
            >
              <SelectTrigger className="h-9 mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSCRIPTION_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Hinglish code-mix works best on Deepgram <code className="px-1 bg-muted rounded">multi</code>
              {" "}and Sarvam <code className="px-1 bg-muted rounded">codemix</code> mode. Shunya detects language automatically.
            </p>
          </div>
        </div>
      </Card>

      <Card title="How it works">
        <div className="p-5 text-sm text-muted-foreground space-y-2 max-w-3xl">
          <p>
            <b className="text-foreground">Deepgram:</b> Vapi sends the call audio directly
            to Deepgram using its native <code className="px-1 bg-muted rounded">transcriber</code> config
            (Nova-3, language <code className="px-1 bg-muted rounded">multi</code>).
            Lowest latency path — nothing runs on our backend during the call.
          </p>
          <p>
            <b className="text-foreground">Sarvam / Shunya:</b> Vapi is handed a
            <code className="mx-1 px-1 bg-muted rounded">custom-transcriber</code> pointing at
            <code className="mx-1 px-1 bg-muted rounded">/ws/custom-transcriber</code> on our API,
            which opens an upstream WebSocket to the vendor, forwards PCM16 frames,
            and relays <code className="px-1 bg-muted rounded">transcriber-response</code> messages back to Vapi.
          </p>
          <p>
            Either way, the rendered Live Assist transcript, sentiment, and suggestions
            come from the same <code className="px-1 bg-muted rounded">/ws/session</code>
            broadcast — so A/B tests stay visually identical across providers.
          </p>
        </div>
      </Card>
    </div>
  );
}
