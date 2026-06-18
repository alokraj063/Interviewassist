import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, RequireAuth, RequirePlatformAdmin, RedirectPlatformAdmin } from "@/auth/AuthContext";
import AppShell from "@/layouts/AppShell";
import PlatformShell from "@/layouts/PlatformShell";
import PlatformTenants from "@/pages/platform/Tenants";
import PlatformTenantDetail from "@/pages/platform/TenantDetail";

import SignIn from "@/pages/auth/SignIn";
import SignUp from "@/pages/auth/SignUp";
import ForgotPassword from "@/pages/auth/ForgotPassword";
import CheckEmail from "@/pages/auth/CheckEmail";
import ResetPassword from "@/pages/auth/ResetPassword";
import VerifyEmail from "@/pages/auth/VerifyEmail";
import AcceptInvite from "@/pages/auth/AcceptInvite";

import LiveAssistSetup from "@/pages/LiveAssistSetup";
import LiveAssistSettings from "@/pages/LiveAssistSettings";
import LiveAssistUsage from "@/pages/LiveAssistUsage";
import NotFound from "@/pages/NotFound";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const queryClient = new QueryClient();

// This app is the Live Assist interview co-pilot only. Everything else from the
// original ATS has been removed; the auth + platform-admin shells stay because
// the feature runs inside the multi-tenant auth they provide.
const App = () => (
  <ErrorBoundary>
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Navigate to="/sign-in" replace />} />
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/sign-up" element={<SignUp />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/check-email" element={<CheckEmail />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />

            <Route element={<RequireAuth><RequirePlatformAdmin><PlatformShell /></RequirePlatformAdmin></RequireAuth>}>
              <Route path="/platform" element={<Navigate to="/platform/tenants" replace />} />
              <Route path="/platform/tenants" element={<PlatformTenants />} />
              <Route path="/platform/tenants/:id" element={<PlatformTenantDetail />} />
            </Route>

            <Route element={<RequireAuth><RedirectPlatformAdmin><AppShell /></RedirectPlatformAdmin></RequireAuth>}>
              <Route path="/" element={<Navigate to="/live-assist" replace />} />
              <Route path="/live-assist" element={<LiveAssistSetup />} />
              <Route path="/live-assist/settings" element={<LiveAssistSettings />} />
              <Route path="/live-assist/usage" element={<LiveAssistUsage />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
