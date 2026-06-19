import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "@/auth/AuthShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

export default function ForgotPassword() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        json: { email },
        auth: false,
      });
    } catch {
      // The endpoint always returns 200 to avoid enumeration, but network errors still fall through.
    }
    // Jump straight to the reset screen with the email pre-filled.
    nav(`/reset-password?email=${encodeURIComponent(email)}`);
  }

  return (
    <AuthShell title="Reset your password" subtitle="Enter your email and we'll send a 6-digit code.">
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <label className="text-xs font-medium block mb-1.5">Work email</label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="you@company.com" required />
        </div>
        <Button type="submit" className="w-full h-10" disabled={submitting}>{submitting ? "Sending…" : "Send reset code"}</Button>
      </form>
      <p className="text-sm text-center text-muted-foreground mt-6">
        <Link to="/sign-in" className="text-primary font-medium hover:underline">← Back to sign in</Link>
      </p>
    </AuthShell>
  );
}
