import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "@/auth/AuthShell";
import { MailCheck, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/auth/AuthContext";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";

export default function VerifyEmail() {
  const { email, refreshMe, isAuthed, user } = useAuth();
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  const verified = !!user?.emailVerifiedAt;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) { toast.error("Enter the 6-digit code."); return; }
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/verify-email", {
        method: "POST",
        json: { code, email: email ?? undefined },
      });
      await refreshMe().catch(() => {});
      toast.success("Email verified");
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      toast.error(
        body?.error === "invalid_code" ? "That code is incorrect or has expired." : "Verification failed",
        { description: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    setResending(true);
    try {
      await apiFetch("/api/auth/resend-verification", {
        method: "POST",
        json: { email: email ?? undefined },
      });
      toast.success("A new code is on the way");
    } catch (err) {
      toast.error("Failed to resend", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setResending(false);
    }
  }

  if (verified) {
    return (
      <AuthShell title="Email verified">
        <div className="flex flex-col items-center text-center py-2">
          <div className="w-12 h-12 rounded-full bg-success-muted flex items-center justify-center mb-4">
            <CheckCircle2 className="w-5 h-5 text-success" />
          </div>
          <p className="text-sm text-muted-foreground mb-6">Your email is verified. Continue to your workspace.</p>
          <Button onClick={() => nav("/")} className="w-full h-10">Continue</Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Verify your email">
      <div className="flex flex-col items-center text-center py-2 mb-2">
        <div className="w-12 h-12 rounded-full bg-primary-muted flex items-center justify-center mb-3">
          <MailCheck className="w-5 h-5 text-primary" />
        </div>
        <p className="text-sm text-muted-foreground">We sent a 6-digit code to</p>
        <p className="text-sm font-medium">{email || "your email"}</p>
      </div>
      <form onSubmit={submit} className="space-y-3.5">
        <Input
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="123456"
          className="text-center text-2xl tracking-[0.5em] font-mono h-14"
          autoFocus
        />
        <Button type="submit" className="w-full h-10" disabled={submitting || code.length !== 6}>
          {submitting ? "Verifying…" : "Verify email"}
        </Button>
      </form>
      <div className="text-center mt-4">
        <button
          type="button"
          onClick={resend}
          className="text-xs text-primary hover:underline disabled:opacity-50"
          disabled={resending || !isAuthed}
        >
          {resending ? "Sending…" : "Resend code"}
        </button>
      </div>
    </AuthShell>
  );
}
