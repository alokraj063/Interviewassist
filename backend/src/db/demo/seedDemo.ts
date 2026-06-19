// Rich-demo tenant seed — RecruitAssist marketing-video walkthrough.
//
// Runs entirely scoped to DEMO_ORG_ID so other tenants (DEFAULT_ORG_ID,
// JOULESTOWATTS_ORG_ID, anything created via /api/platform/orgs) are never
// touched. Idempotent: re-run drops the demo org's domain rows and rebuilds.
//
// Verification recipe:
//   1. `pnpm db:seed-demo` and confirm phases print clean.
//   2. SQL spot-check (counts should match — see plan file at
//      /Users/Daniel/.claude/plans/i-want-to-record-dazzling-deer.md).
//   3. Re-run; counts identical (idempotency).
//   4. Sign in as `demo@demo.recruitassist.local` / `Demo#2026`; click every
//      sidebar entry and confirm populated state.

// Load .env first.
import "../../env.js";
import { env } from "../../env.js";
import { seedDefaultVoiceAgents } from "../seedAgents.js";
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
  DEMO_RNG_SEED,
} from "./constants.js";
import { emptyContext } from "./context.js";
import { rngSeeded } from "./rng.js";
import { wipeDemoOrg } from "./wipe.js";
import { seedDemoIdentity } from "./identity.js";
import { ensureDemoTaxonomy } from "./taxonomy.js";
import {
  seedDemoCandidates,
  seedDemoClients,
  seedDemoDemands,
  seedDemoJdMatchRuns,
  seedDemoProspects,
  seedDemoSubmissionsAndDownstream,
} from "./pipeline.js";
import { seedDemoCalls, seedDemoRubrics } from "./calls.js";
import { seedDemoRubricExtras } from "./rubrics.js";
import { seedDemoVoiceCampaigns } from "./voiceCampaigns.js";
import { seedDemoAssessments } from "./assessments.js";
import { seedDemoCoaching } from "./coaching.js";
import { seedDemoKnowledge } from "./knowledge.js";
import { seedDemoConfig } from "./config.js";

function checkProductionGuard(): void {
  if (env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "1") {
    throw new Error(
      "Refusing to run demo seed in production. Set ALLOW_DEMO_SEED=1 to override.",
    );
  }
}

export async function seedDemoOrg(): Promise<void> {
  checkProductionGuard();

  const startedAt = Date.now();
  console.log("[demo-seed] starting…");
  console.log(`[demo-seed] target org = ${DEMO_ORG_ID}`);

  const ctx = emptyContext();
  const rng = rngSeeded(DEMO_RNG_SEED);

  console.log("[demo-seed] phase: wipe");
  await wipeDemoOrg();

  console.log("[demo-seed] phase: identity (org + users + memberships)");
  await seedDemoIdentity(ctx);

  console.log("[demo-seed] phase: taxonomy ensure");
  await ensureDemoTaxonomy(ctx);

  console.log("[demo-seed] phase: clients + demands");
  await seedDemoClients(ctx);
  await seedDemoDemands(ctx, rng);

  console.log("[demo-seed] phase: candidates + parsed resumes");
  await seedDemoCandidates(ctx, rng);

  console.log("[demo-seed] phase: prospects");
  await seedDemoProspects(ctx, rng);

  console.log("[demo-seed] phase: submissions + interviews + selections + offers");
  await seedDemoSubmissionsAndDownstream(ctx, rng);

  console.log("[demo-seed] phase: jd match runs");
  await seedDemoJdMatchRuns(ctx, rng);

  console.log("[demo-seed] phase: rubrics");
  await seedDemoRubrics(ctx);
  await seedDemoRubricExtras(ctx);

  console.log("[demo-seed] phase: voice agent templates (idempotent)");
  await seedDefaultVoiceAgents([DEMO_ORG_ID]);

  console.log("[demo-seed] phase: calls + transcripts + scores + qa + technical_qa");
  await seedDemoCalls(ctx, rng);

  console.log("[demo-seed] phase: voice campaigns + targets");
  await seedDemoVoiceCampaigns(ctx, rng);

  console.log("[demo-seed] phase: assessments + async video + proctor");
  await seedDemoAssessments(ctx, rng);

  console.log("[demo-seed] phase: coaching scenarios + runs");
  await seedDemoCoaching(ctx, rng);

  console.log("[demo-seed] phase: knowledge sources + chunks");
  await seedDemoKnowledge(ctx, rng);

  console.log("[demo-seed] phase: question banks + tenant integrations");
  await seedDemoConfig(ctx, rng);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("[demo-seed] done.");
  console.log(`[demo-seed] elapsed: ${elapsed}s`);
  console.log(`[demo-seed] login: ${DEMO_ADMIN_EMAIL} / ${DEMO_PASSWORD}`);
}

const isDirectExec = import.meta.url === `file://${process.argv[1]}`;
if (isDirectExec) {
  seedDemoOrg()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
