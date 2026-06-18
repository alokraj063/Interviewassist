import { Link } from "react-router-dom";
import { AuthShell } from "@/auth/AuthShell";
import { Button } from "@/components/ui/button";

// Self-serve signup is disabled — tenants are provisioned by platform admins
// and arrive at the app via the invitation flow (/accept-invite). This page
// remains so old links don't 404, but the form is gone.
export default function SignUp() {
  return (
    <AuthShell
      title="Sign-up by invitation only"
      subtitle="New workspaces are provisioned by an administrator. If you're expecting access, ask them for an invitation link."
    >
      <div className="space-y-4 text-sm text-muted-foreground">
        <p>
          Once your administrator creates your workspace and sends an invite, the
          email will include a link that takes you straight to setting your password.
        </p>
        <Button asChild className="w-full">
          <Link to="/sign-in">I already have an account</Link>
        </Button>
      </div>
    </AuthShell>
  );
}
