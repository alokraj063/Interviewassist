import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthShell } from "@/auth/AuthShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";

export default function ResetPassword() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) { toast.error("Enter the 6-digit code from the email."); return; }
    if (pw !== pw2) { toast.error("Passwords don't match"); return; }
    if (pw.length < 8) { toast.error("Password must be at least 8 characters"); return; }
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/reset-password", {
        method: "POST",
        json: { email, code, password: pw },
        auth: false,
      });
      toast.success("Password updated");
      nav("/sign-in");
    } catch (err) {
      const body = (err as { body?: { error?: string } })?.body;
      toast.error(
        body?.error === "invalid_code" ? "That code is incorrect or has expired." : "Reset failed",
        { description: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Set a new password" subtitle={`Check your inbox for the 6-digit code${email ? ` sent to ${email}` : ""}.`}>
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <label className="text-xs font-medium block mb-1.5">Email</label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5">6-digit code</label>
          <Input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            className="text-center text-2xl tracking-[0.5em] font-mono h-14"
            required
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5">New password</label>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5">Confirm new password</label>
          <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
        </div>
        <Button type="submit" className="w-full h-10" disabled={submitting}>{submitting ? "Updating…" : "Update password"}</Button>
      </form>
    </AuthShell>
  );
}
