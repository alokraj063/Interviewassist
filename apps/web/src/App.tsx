import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate, useParams } from "react-router-dom";
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

import Home from "@/pages/Home";
import Demands from "@/pages/Demands";
import DemandDetail from "@/pages/DemandDetail";
import Candidates from "@/pages/Candidates";
import CandidateDetail from "@/pages/CandidateDetail";
import CandidateNew from "@/pages/CandidateNew";
import QAReview from "@/pages/QAReview";
import QAReviewerScorecard from "@/pages/QAReviewerScorecard";
import QADisputeDetail from "@/pages/QADisputeDetail";
import Coaching from "@/pages/Coaching";
import CoachingDetail from "@/pages/CoachingDetail";
import SimulationRunner from "@/pages/SimulationRunner";
import SimulationResults from "@/pages/SimulationResults";
import Recruiters from "@/pages/Recruiters";
import RecruiterDetail from "@/pages/RecruiterDetail";
import LiveAssist from "@/pages/LiveAssist";
import LiveAssistSetup from "@/pages/LiveAssistSetup";
import LiveAssistSettings from "@/pages/LiveAssistSettings";
import Calls from "@/pages/Calls";
import CallDetail from "@/pages/CallDetail";
import TeamMonitor from "@/pages/TeamMonitor";
import TeamMonitorReplay from "@/pages/TeamMonitorReplay";
import VoiceAgents from "@/pages/VoiceAgents";
import VoiceAgentCreate from "@/pages/VoiceAgentCreate";
import VoiceAgentDetail from "@/pages/VoiceAgentDetail";
import Triage from "@/pages/Triage";
import TriageFlowDetail from "@/pages/TriageFlowDetail";
import Rubrics from "@/pages/Rubrics";
import RubricEditor from "@/pages/RubricEditor";
import RubricVersionView from "@/pages/RubricVersionView";
import Knowledge from "@/pages/Knowledge";
import KnowledgeDetail from "@/pages/KnowledgeDetail";
import KnowledgeSourceDetail from "@/pages/KnowledgeSourceDetail";
import KnowledgeCollectionDetail from "@/pages/KnowledgeCollectionDetail";
import Analytics from "@/pages/Analytics";
import Settings from "@/pages/Settings";
import NotFound from "@/pages/NotFound";
import TakeAssessment from "@/pages/TakeAssessment";
import SubmitVideo from "@/pages/SubmitVideo";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Phase 1 additions
import QuestionBanks from "@/pages/QuestionBanks";
import QuestionBankDetail from "@/pages/QuestionBankDetail";
import QuestionDetail from "@/pages/QuestionDetail";
import QuestionReviewQueue from "@/pages/QuestionReviewQueue";
import Sourcing from "@/pages/sourcing/Sourcing";
import Assessments from "@/pages/Assessments";
import AssessmentDetail from "@/pages/AssessmentDetail";
import AssessmentBuilder from "@/pages/AssessmentBuilder";
import AssessmentResults from "@/pages/AssessmentResults";
import AttemptReview from "@/pages/AttemptReview";
import AsyncVideo from "@/pages/AsyncVideo";
import AsyncVideoDetail from "@/pages/AsyncVideoDetail";
import AsyncVideoReview from "@/pages/AsyncVideoReview";
import AsyncVideoCompare from "@/pages/AsyncVideoCompare";
import ExternalReview from "@/pages/ExternalReview";
import ProctorCockpit from "@/pages/ProctorCockpit";
import ProctorSessionDetail from "@/pages/ProctorSessionDetail";
import ProctorReviewQueue from "@/pages/ProctorReviewQueue";
import ProctorSettings from "@/pages/ProctorSettings";
import ClientPortal from "@/pages/ClientPortal";
import OfferLetterSync from "@/pages/admin/OfferLetterSync";

const queryClient = new QueryClient();

// Adapter so /live-call/:callId mounts LiveAssist with the callId surfaced
// via search params (which is how LiveAssist reads it). This keeps LiveAssist
// itself routing-shape agnostic.
function LiveCallRoute() {
  const { callId } = useParams<{ callId: string }>();
  // useSearchParams reads URLSearchParams off window.location, so set them
  // imperatively before rendering.
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (callId && params.get("callId") !== callId) {
      params.set("callId", callId);
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    }
  }
  return <LiveAssist />;
}

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

            {/* Public, candidate-facing surfaces — no auth, token in URL */}
            <Route path="/take-assessment/:token" element={<TakeAssessment />} />
            <Route path="/async-video/submit/:token" element={<SubmitVideo />} />
            <Route path="/external-review/:token" element={<ExternalReview />} />

            <Route element={<RequireAuth><RequirePlatformAdmin><PlatformShell /></RequirePlatformAdmin></RequireAuth>}>
              <Route path="/platform" element={<Navigate to="/platform/tenants" replace />} />
              <Route path="/platform/tenants" element={<PlatformTenants />} />
              <Route path="/platform/tenants/:id" element={<PlatformTenantDetail />} />
            </Route>

            <Route element={<RequireAuth><RedirectPlatformAdmin><AppShell /></RedirectPlatformAdmin></RequireAuth>}>
              {/* Focused on Live Assist: land straight on the live-assist surface.
                  (Home and the rest of the IA still exist + are reachable by URL.) */}
              <Route path="/" element={<Navigate to="/live-assist" replace />} />

              {/* Pipeline */}
              <Route path="/demands" element={<Demands />} />
              <Route path="/demands/:id" element={<DemandDetail />} />
              <Route path="/candidates" element={<Candidates />} />
              <Route path="/candidates/new" element={<CandidateNew />} />
              <Route path="/candidates/:id" element={<CandidateDetail />} />

              {/* Live work */}
              <Route path="/live-assist" element={<LiveAssistSetup />} />
              <Route path="/live-assist/settings" element={<LiveAssistSettings />} />
              <Route path="/live-assist/legacy" element={<LiveAssist />} />
              <Route path="/live-call/:callId" element={<LiveCallRoute />} />
              <Route path="/calls" element={<Calls />} />
              <Route path="/calls/:id" element={<CallDetail />} />
              <Route path="/qa-review" element={<QAReview />} />
              <Route path="/qa-review/reviewers/:userId" element={<QAReviewerScorecard />} />
              <Route path="/qa-review/disputes/:id" element={<QADisputeDetail />} />
              <Route path="/coaching" element={<Coaching />} />
              <Route path="/coaching/:id" element={<CoachingDetail />} />
              <Route path="/coaching/:id/simulate" element={<SimulationRunner />} />
              <Route path="/coaching/:id/results" element={<SimulationResults />} />
              <Route path="/triage" element={<Triage />} />
              <Route path="/triage/flows/:id" element={<TriageFlowDetail />} />

              {/* Sourcing & Assessment */}
              <Route path="/sourcing" element={<Navigate to="/sourcing/internal-db" replace />} />
              <Route path="/sourcing/:tab" element={<Sourcing />} />
              <Route path="/assessments" element={<Assessments />} />
              <Route path="/assessments/:id" element={<AssessmentDetail />} />
              <Route path="/assessments/:id/build" element={<AssessmentBuilder />} />
              <Route path="/assessments/:id/results" element={<AssessmentResults />} />
              <Route path="/attempts/:id" element={<AttemptReview />} />
              <Route path="/async-video" element={<AsyncVideo />} />
              <Route path="/async-video/:id" element={<AsyncVideoDetail />} />
              <Route path="/async-video/:campaignId/compare" element={<AsyncVideoCompare />} />
              <Route path="/async-video/:campaignId/submissions/:submissionId" element={<AsyncVideoReview />} />
              <Route path="/proctor" element={<ProctorCockpit />} />
              <Route path="/proctor/review" element={<ProctorReviewQueue />} />
              <Route path="/proctor/settings" element={<ProctorSettings />} />
              <Route path="/proctor/sessions/:id" element={<ProctorSessionDetail />} />

              {/* People & clients */}
              <Route path="/recruiters" element={<Recruiters />} />
              <Route path="/recruiters/:id" element={<RecruiterDetail />} />
              <Route path="/team-monitor" element={<TeamMonitor />} />
              <Route path="/team-monitor/replay" element={<TeamMonitorReplay />} />
              <Route path="/voice-agents" element={<VoiceAgents />} />
              <Route path="/voice-agents/new" element={<VoiceAgentCreate />} />
              <Route path="/voice-agents/:id" element={<VoiceAgentDetail />} />
              <Route path="/client-portal" element={<ClientPortal />} />

              {/* Config */}
              <Route path="/rubrics" element={<Rubrics />} />
              <Route path="/rubrics/:id" element={<RubricEditor />} />
              <Route path="/rubrics/:id/versions/:version" element={<RubricVersionView />} />
              <Route path="/question-banks" element={<QuestionBanks />} />
              <Route path="/question-banks/review-queue" element={<QuestionReviewQueue />} />
              <Route path="/question-banks/:id" element={<QuestionBankDetail />} />
              <Route
                path="/question-banks/:id/questions/:qid"
                element={<QuestionDetail />}
              />
              <Route path="/knowledge" element={<Knowledge />} />
              <Route path="/knowledge/sources/:id" element={<KnowledgeSourceDetail />} />
              <Route path="/knowledge/collections/:id" element={<KnowledgeCollectionDetail />} />
              <Route path="/knowledge/:id" element={<KnowledgeDetail />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
              <Route path="/settings/:section" element={<Settings />} />

              {/* Admin */}
              <Route path="/admin/offer-letter-sync" element={<OfferLetterSync />} />

              {/* Legacy URL redirects (one cycle) */}
              <Route path="/agents" element={<Navigate to="/recruiters" replace />} />
              <Route path="/agents/:id" element={<RecruiterDetailRedirect />} />
              <Route path="/supervisor-monitor" element={<Navigate to="/team-monitor" replace />} />
              <Route path="/scorecards" element={<Navigate to="/rubrics" replace />} />
              <Route path="/scorecards/:id" element={<RubricEditorRedirect />} />
              <Route path="/conversations" element={<Navigate to="/calls" replace />} />
              <Route path="/conversations/:id" element={<CallDetailRedirect />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </ErrorBoundary>
);

// Tiny redirect adapters that preserve the :id from old URL into the new route
function RecruiterDetailRedirect() {
  const { id } = useParams();
  return <Navigate to={`/recruiters/${id}`} replace />;
}
function RubricEditorRedirect() {
  const { id } = useParams();
  return <Navigate to={`/rubrics/${id}`} replace />;
}
function CallDetailRedirect() {
  const { id } = useParams();
  return <Navigate to={`/calls/${id}`} replace />;
}

export default App;
