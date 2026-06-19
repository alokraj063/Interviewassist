import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui-kit";
import { ShieldCheck, ShieldX, ShieldQuestion, ScanFace, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  errMessage,
  serverErrorCode,
  useRunFaceMatch,
  useVerifyIdentity,
  type IdentityCheck,
} from "@/hooks/useProctor";

const STATUS_PILL: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  verified: "bg-success/15 text-success",
  mismatch: "bg-destructive/15 text-destructive",
  skipped: "bg-muted text-muted-foreground",
};

function Thumb({ label, blobKey }: { label: string; blobKey: string | null }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">{label}</div>
      <div className="aspect-[3/4] rounded-md border border-border bg-muted/40 flex items-center justify-center overflow-hidden">
        {blobKey ? (
          <div className="flex flex-col items-center text-muted-foreground gap-1 p-2 text-center">
            <ImageIcon className="w-5 h-5" aria-hidden />
            <span className="text-[10px] break-all leading-tight">{blobKey.split("/").pop()}</span>
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">not captured</span>
        )}
      </div>
    </div>
  );
}

export function IdentityPanel({
  sessionId,
  identity,
  canReview,
}: {
  sessionId: string;
  identity: IdentityCheck | null;
  canReview: boolean;
}) {
  const verify = useVerifyIdentity();
  const faceMatch = useRunFaceMatch();

  const doVerify = (status: "verified" | "mismatch" | "skipped") => {
    verify.mutate(
      { sessionId, status },
      {
        onSuccess: () => toast.success(`Identity marked ${status}`),
        onError: (e) => toast.error("Verify failed", { description: errMessage(e) }),
      },
    );
  };

  const runMatch = () => {
    faceMatch.mutate(
      { sessionId },
      {
        onSuccess: (d) => toast.success(`Face match: ${d.matchScore} (${d.provider})`),
        onError: (e) => {
          const code = serverErrorCode(e);
          if (code === "face_match_provider_missing") {
            toast.error("Face-match provider not configured", {
              description: "Set AWS_REKOGNITION_* to enable the real provider. Running on the stub.",
            });
          } else {
            toast.error("Face match failed", { description: errMessage(e) });
          }
        },
      },
    );
  };

  return (
    <Card title="Identity verification">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className={cn("pill text-[11px] capitalize", STATUS_PILL[identity?.status ?? "pending"])}>
            {identity?.status ?? "pending"}
          </span>
          {identity?.matchScore != null && (
            <span className="text-xs text-muted-foreground">
              Match score: <span className="font-medium tabular-nums">{identity.matchScore}</span>
              {identity.matchProvider ? ` · ${identity.matchProvider}` : ""}
            </span>
          )}
        </div>

        <div className="flex gap-2">
          <Thumb label="Gov ID" blobKey={identity?.idPhotoBlobKey ?? null} />
          <Thumb label="Selfie" blobKey={identity?.selfieBlobKey ?? null} />
          <Thumb label="Env scan" blobKey={identity?.envScanBlobKey ?? null} />
        </div>

        {canReview && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={runMatch}
              disabled={faceMatch.isPending}
            >
              <ScanFace className="w-3.5 h-3.5 mr-1.5" /> Run face match
            </Button>
            <Button size="sm" variant="outline" onClick={() => doVerify("verified")} disabled={verify.isPending}>
              <ShieldCheck className="w-3.5 h-3.5 mr-1.5 text-success" /> Verify
            </Button>
            <Button size="sm" variant="outline" onClick={() => doVerify("mismatch")} disabled={verify.isPending}>
              <ShieldX className="w-3.5 h-3.5 mr-1.5 text-destructive" /> Mismatch
            </Button>
            <Button size="sm" variant="ghost" onClick={() => doVerify("skipped")} disabled={verify.isPending}>
              <ShieldQuestion className="w-3.5 h-3.5 mr-1.5" /> Skip
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
