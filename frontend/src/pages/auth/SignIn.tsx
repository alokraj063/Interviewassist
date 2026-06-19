import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell, AuthDivider, SsoButtons } from "@/auth/AuthShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/auth/AuthContext";
import { toast } from "sonner";

export default function SignIn() {
  const nav = useNavigate();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await signIn(email, password);
      nav("/", { replace: true });
    } catch (err) {
      const body = (err as { body?: { error?: string } })?.body;
      const code = body?.error;
      const msg =
        code === "invalid_credentials"
          ? "Email or password is incorrect."
          : code === "account_suspended"
            ? "This account has been suspended."
            : err instanceof Error
              ? err.message
              : "Unexpected error";
      toast.error("Sign in failed", { description: msg });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Sign in to RecruitAssist" subtitle="Use your work email to access your workspace.">
      <SsoButtons />
      <AuthDivider />
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <label htmlFor="signin-email" className="text-xs font-medium text-foreground mb-1.5 block">Work email</label>
          <Input id="signin-email" value={email} onChange={e => setEmail(e.target.value)} type="email" required />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="signin-password" className="text-xs font-medium text-foreground">Password</label>
            <Link to="/forgot-password" className="text-xs text-primary hover:underline">Forgot password?</Link>
          </div>
          <Input id="signin-password" value={password} onChange={e => setPassword(e.target.value)} type="password" required />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(!!v)} />
          <span className="text-muted-foreground">Remember me on this device</span>
        </label>
        <Button type="submit" className="w-full h-10" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="text-sm text-center text-muted-foreground mt-6">
        New to RecruitAssist? <Link to="/sign-up" className="text-primary font-medium hover:underline">Create a workspace</Link>
      </p>
    </AuthShell>
  );
}
