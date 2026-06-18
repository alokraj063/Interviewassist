import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, setAccessToken, silentRefresh } from "@/lib/api";

export type Role =
  | "recruiter"
  | "delivery_lead"
  | "account_manager"
  | "business_head"
  | "qa_reviewer"
  | "admin"
  | "client_user"
  | "proctor"
  // Legacy contact-center roles, kept for backwards compat with any
  // unmigrated data; safe to drop once /live-assist/legacy goes away.
  | "agent"
  | "team_lead"
  | "manager";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  membershipStatus: "invited" | "active" | "suspended";
  emailVerifiedAt: string | null;
  mfaEnrolledAt: string | null;
  org: { id: string; name: string };
  permissions: string[];
  /**
   * Super-admin flag. Platform admins access /platform/* (tenant management +
   * integration credentials) and don't have org-scoped permissions.
   */
  isPlatformAdmin: boolean;
}

interface AuthState {
  ready: boolean;
  user: AuthUser | null;
  isAuthed: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
  can: (permission: string) => boolean;
  // Back-compat fields that older components read directly.
  email: string | null;
  workspace: string;
  token: string | null;
}

const Ctx = createContext<AuthState | null>(null);

interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Attempt silent refresh on mount — if the refresh cookie is valid we
    // restore the session without requiring the user to sign in again.
    let cancelled = false;
    (async () => {
      const res = await silentRefresh();
      if (cancelled) return;
      if (res) setUser(res.user as AuthUser);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await apiFetch<LoginResponse>("/api/auth/login", {
      method: "POST",
      json: { email, password },
      auth: false,
    });
    setAccessToken(res.accessToken);
    setUser(res.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST", auth: false });
    } catch {
      // Server-side revocation failed — still clear client state.
    }
    setAccessToken(null);
    setUser(null);
  }, []);

  const refreshMe = useCallback(async () => {
    const res = await apiFetch<{ user: AuthUser }>("/api/auth/me");
    setUser(res.user);
  }, []);

  const can = useCallback(
    (permission: string) => !!user && user.permissions.includes(permission),
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({
      ready,
      user,
      isAuthed: !!user,
      signIn,
      signOut,
      refreshMe,
      can,
      email: user?.email ?? null,
      workspace: user?.org.name ?? "",
      token: null, // token no longer exposed; use lib/api getAccessToken if needed
    }),
    [ready, user, signIn, signOut, refreshMe, can],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

export function useCan(permission: string): boolean {
  return useAuth().can(permission);
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, isAuthed } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (ready && !isAuthed) nav("/sign-in", { replace: true });
  }, [ready, isAuthed, nav]);
  if (!ready) return null;
  if (!isAuthed) return null;
  return <>{children}</>;
}

export function RequirePermission({ permission, children, fallback }: { permission: string; children: ReactNode; fallback?: ReactNode }) {
  const can = useCan(permission);
  if (!can) return <>{fallback ?? null}</>;
  return <>{children}</>;
}

/** Render only when the signed-in user is a platform admin. Sends others home. */
export function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const { ready, user } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (ready && (!user || !user.isPlatformAdmin)) nav("/", { replace: true });
  }, [ready, user, nav]);
  if (!ready || !user?.isPlatformAdmin) return null;
  return <>{children}</>;
}

/** Render only when the signed-in user is NOT a platform admin. Sends platform admins to /platform. */
export function RedirectPlatformAdmin({ children }: { children: ReactNode }) {
  const { ready, user } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (ready && user?.isPlatformAdmin) nav("/platform", { replace: true });
  }, [ready, user, nav]);
  if (!ready) return null;
  if (user?.isPlatformAdmin) return null;
  return <>{children}</>;
}
