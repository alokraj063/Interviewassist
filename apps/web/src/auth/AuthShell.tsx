import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";

export function AuthShell({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-primary-muted via-background to-accent-muted">
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-[420px]">
          <div className="flex justify-center mb-6">
            <Logo size={52} />
          </div>
          <div className="bg-background border border-border rounded-xl shadow-[var(--shadow-elegant)] p-8">
            <h1 className="text-[22px] font-semibold tracking-tight mb-1">{title}</h1>
            {subtitle && <p className="text-sm text-muted-foreground mb-6">{subtitle}</p>}
            {children}
          </div>
          <div className="mt-6 flex items-center justify-center gap-5 text-xs text-muted-foreground">
            <Link to="#" className="hover:text-foreground">Terms</Link>
            <Link to="#" className="hover:text-foreground">Privacy</Link>
            <Link to="#" className="hover:text-foreground">Security</Link>
            <span>© 2026 RecruitAssist</span>
          </div>
        </div>
      </main>
    </div>
  );
}

export function SsoButtons() {
  const providers = [
    { name: "Google", svg: <svg viewBox="0 0 48 48" width="16" height="16"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.8 16.1 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35 26.7 36 24 36c-5.3 0-9.7-3.6-11.3-8.5l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2c-.4.4 6.6-4.8 6.6-14.8 0-1.3-.1-2.3-.4-3.5z"/></svg> },
    { name: "Microsoft", svg: <svg viewBox="0 0 23 23" width="14" height="14"><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M12 1h10v10H12z"/><path fill="#05a6f0" d="M1 12h10v10H1z"/><path fill="#ffba08" d="M12 12h10v10H12z"/></svg> },
    { name: "SAML SSO", svg: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3 6 6 1-4.5 4.5 1.5 6.5-6-3-6 3 1.5-6.5L3 9l6-1z"/></svg> },
  ];
  return (
    <div className="space-y-2">
      {providers.map(p => (
        <button key={p.name} type="button" className="w-full h-10 inline-flex items-center justify-center gap-2.5 border border-border rounded-md text-sm font-medium hover:bg-muted/50 transition-colors">
          {p.svg}
          <span>Continue with {p.name}</span>
        </button>
      ))}
    </div>
  );
}

export function AuthDivider({ text = "or" }: { text?: string }) {
  return (
    <div className="my-5 flex items-center gap-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{text}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}
