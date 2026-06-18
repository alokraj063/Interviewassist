import { useState } from "react";
import { cn } from "@/lib/utils";
import { QuestionBankPanel } from "./QuestionBankPanel";
import { RubricLivePanel, type LiveRubricSnapshot } from "./RubricLivePanel";
import { CompliancePanel } from "./CompliancePanel";
import { NotesPanel } from "./NotesPanel";

type RightTab = "question-bank" | "rubric" | "compliance" | "notes";

export function RightPanelTabs({
  callId,
  liveRubric,
  demandId,
  onAsk,
}: {
  callId?: string;
  liveRubric?: LiveRubricSnapshot | null;
  demandId?: string;
  onAsk?: (question: string, category: string) => void;
}) {
  const [tab, setTab] = useState<RightTab>("question-bank");
  const tabs: { id: RightTab; label: string }[] = [
    { id: "question-bank", label: "Question bank" },
    { id: "rubric", label: "Rubric live" },
    { id: "compliance", label: "Discovery" },
    { id: "notes", label: "Notes" },
  ];
  return (
    <div className="bg-card border border-border rounded-lg flex flex-col min-h-0 h-full overflow-hidden">
      <div className="flex border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors",
              tab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "question-bank" && <QuestionBankPanel demandId={demandId} onAsk={onAsk} />}
        {tab === "rubric" && <RubricLivePanel liveRubric={liveRubric} />}
        {tab === "compliance" && <CompliancePanel />}
        {tab === "notes" && <NotesPanel callId={callId} />}
      </div>
    </div>
  );
}
