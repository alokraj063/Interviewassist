import { Link } from "react-router-dom";
import { AuthShell } from "@/auth/AuthShell";
import { Mail } from "lucide-react";

export default function CheckEmail() {
  const email = sessionStorage.getItem("j2w_reset_email") || "your email";
  return (
    <AuthShell title="Check your email">
      <div className="flex flex-col items-center text-center py-2">
        <div className="w-12 h-12 rounded-full bg-primary-muted flex items-center justify-center mb-4">
          <Mail className="w-5 h-5 text-primary" />
        </div>
        <p className="text-sm text-muted-foreground mb-1">We sent a password reset link to</p>
        <p className="text-sm font-medium mb-6">{email}</p>
        <p className="text-xs text-muted-foreground mb-4">The link expires in 30 minutes. Check your spam folder if you don't see it.</p>
        <Link to="/reset-password" className="text-sm text-primary font-medium hover:underline">I have my reset link →</Link>
      </div>
      <div className="mt-6 text-center">
        <Link to="/sign-in" className="text-xs text-muted-foreground hover:text-foreground">Back to sign in</Link>
      </div>
    </AuthShell>
  );
}
