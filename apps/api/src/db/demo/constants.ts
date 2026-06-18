// Knobs for the marketing-video demo seed. Volumes here aim for "lived-in"
// not "stress-test": enough rows on every page to look real, few enough that
// a reset round-trips in seconds.
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ORG_ID,
  DEMO_ORG_NAME,
  DEMO_ORG_SLUG,
  DEMO_USER_EMAIL_DOMAIN,
} from "@j2w/db";

export const DEMO_PASSWORD = "Demo#2026";
export const DEMO_RNG_SEED = 20260510;

// Stable physical-WAV cap. The audio player reads duration from
// recording_duration_ms, not the file, so a 30-sec silence file plays under
// any displayed duration we want.
export const WAV_PHYSICAL_DURATION_SEC = 30;

export const VOLUMES = {
  recruiters: 12,
  qa: 2,
  businessHeads: 2,
  accountManagers: 3,
  deliveryLeads: 5,
  proctors: 1,
  clientUsers: 1,
  clients: 4,
  demands: 12,
  candidates: 60,
  prospects: 80,
  submissions: 35,
  callsBrowserMixed: 30,
  callsVapiOutbound: 10,
  qaReviews: 18,
  prospectCalls: 50,
  voiceCampaigns: 6,
  voiceCallTargets: 80,
  assessmentTemplates: 5,
  assessmentAttempts: 30,
  asyncVideoCampaigns: 3,
  asyncVideoSubmissions: 20,
  proctorSessions: 18,
  proctorEvents: 60,
  coachingScenarios: 6,
  coachingRuns: 25,
  kbSources: 4,
  questionBanks: 4,
} as const;

export {
  DEMO_ADMIN_EMAIL,
  DEMO_ORG_ID,
  DEMO_ORG_NAME,
  DEMO_ORG_SLUG,
  DEMO_USER_EMAIL_DOMAIN,
};
