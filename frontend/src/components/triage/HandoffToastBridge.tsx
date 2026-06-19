// Listens for triage_handoff_offered events on /ws/agent and surfaces an
// Accept/Decline toast from anywhere in the app. Mounted once at the
// AppShell level so users get the prompt regardless of which page they
// happen to be on when a triage call lands on them.

import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAgentEvents } from "@/hooks/useAgentWs";
import { acceptTriageHandoff } from "@/lib/triageApi";

export function HandoffToastBridge() {
  const nav = useNavigate();

  useAgentEvents((ev) => {
    if (ev.type === "triage_handoff_offered") {
      const intent = ev.classification.intent;
      const conf = Math.round(ev.classification.confidence * 100);
      toast(
        `Incoming triage call — ${intent[0].toUpperCase() + intent.slice(1)} (${conf}%)`,
        {
          duration: 25_000,
          description: ev.summary,
          action: {
            label: "Accept",
            onClick: () => {
              void (async () => {
                try {
                  await acceptTriageHandoff(ev.callId);
                  nav("/live-assist");
                  toast.success(`Connected — ${ev.triageFlowName}`);
                } catch (err) {
                  toast.error("Couldn't accept handoff", {
                    description: err instanceof Error ? err.message : String(err),
                  });
                }
              })();
            },
          },
          cancel: {
            label: "Decline",
            onClick: () => {
              // Phase 2: server-side decline isn't wired yet — the offer
              // simply expires after expiresAt. A "decline" emits no API
              // call and the next idle user picks up.
              toast.message("Declined");
            },
          },
        },
      );
    } else if (ev.type === "triage_handoff_failed" && ev.reason !== "no_matching_rule") {
      toast.error("Triage handoff failed", { description: ev.reason });
    }
  });

  // Stash navigate handler on window for the action callback to access — not
  // needed; we capture it via closure above. Component renders nothing.
  return null;
}

// Intentionally re-export as the default for AppShell's import to be able to
// mount it without naming worries.
export default HandoffToastBridge;
