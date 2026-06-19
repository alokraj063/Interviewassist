import { useRef, useState } from "react";
import { FileUp, Loader2, FileCheck2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  onFile: (file: File) => Promise<void> | void;
  isPending: boolean;
  // null = no result yet; string = error to display; object = success summary.
  status?:
    | null
    | { kind: "error"; message: string }
    | {
        kind: "ok";
        message: string;
      };
  label?: string;
  hint?: string;
  accept?: string;
  maxBytes?: number;
}

const DEFAULT_ACCEPT = ".pdf,.doc,.docx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function ResumeDropzone({
  onFile,
  isPending,
  status,
  label = "Upload a resume",
  hint = "PDF, DOCX, or plain text · up to 10 MB",
  accept = DEFAULT_ACCEPT,
  maxBytes = DEFAULT_MAX_BYTES,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function handleFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.size > maxBytes) {
      setLocalError(`File is ${(file.size / 1024 / 1024).toFixed(1)} MB; maximum is ${maxBytes / 1024 / 1024} MB.`);
      return;
    }
    setLocalError(null);
    void onFile(file);
  }

  return (
    <div className="space-y-2">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`block border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
          hover ? "border-primary bg-primary/5" : "border-border hover:border-primary/60 bg-muted/40"
        } ${isPending ? "opacity-70 pointer-events-none" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
          disabled={isPending}
        />
        <div className="flex flex-col items-center gap-2 text-sm">
          {isPending ? (
            <>
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <div className="font-medium">Parsing resume…</div>
              <div className="text-xs text-muted-foreground">This usually takes 5–10 seconds.</div>
            </>
          ) : (
            <>
              <FileUp className="w-6 h-6 text-muted-foreground" />
              <div className="font-medium">{label}</div>
              <div className="text-xs text-muted-foreground">{hint}</div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-1"
                onClick={(e) => {
                  e.preventDefault();
                  inputRef.current?.click();
                }}
              >
                Choose file
              </Button>
              <div className="text-[11px] text-muted-foreground">or drag &amp; drop</div>
            </>
          )}
        </div>
      </label>

      {localError && (
        <div className="text-xs text-destructive flex items-center gap-1">
          <AlertTriangle className="w-3.5 h-3.5" /> {localError}
        </div>
      )}
      {status?.kind === "error" && (
        <div className="text-xs text-destructive flex items-center gap-1">
          <AlertTriangle className="w-3.5 h-3.5" /> {status.message}
        </div>
      )}
      {status?.kind === "ok" && (
        <div className="text-xs text-success flex items-center gap-1">
          <FileCheck2 className="w-3.5 h-3.5" /> {status.message}
        </div>
      )}
    </div>
  );
}
