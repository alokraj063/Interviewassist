// Demo seed extras for the Rubrics page (enterprise rebuild).
//
// Runs AFTER seedDemoRubrics(ctx) (which inserts 3 v1 rubrics and populates
// ctx.rubricIdByPurpose). This module:
//   1. Upgrades the 3 base rubrics to the V2 criterion shape (anchors +
//      minEvidenceQuotes), marks them published, and writes a v1 snapshot +
//      audit trail for each.
//   2. Adds 5 more rubrics spanning purposes/statuses (published default,
//      hr_screen, a draft, an archived legacy rubric, a client-scoped one).
//   3. Seeds rubric_audit_log rows so the Activity tab renders non-empty.
// QA-review criterion overrides already exist from seedDemoCalls, which powers
// the calibration view.
import { and, eq } from "drizzle-orm";
import {
  callRubricVersions,
  callRubrics,
  db,
  rubricAuditLog,
  type RubricAuditAction,
  type RubricCriterionV2,
} from "@j2w/db";
import { DEMO_ORG_ID } from "./constants.js";
import type { DemoContext } from "./context.js";
import { daysAgo } from "./rng.js";

function anchored(
  id: string,
  name: string,
  kind: RubricCriterionV2["kind"],
  weight: number,
  fail: string,
  pass: string,
  excellent: string,
  minEvidence = 1,
): RubricCriterionV2 {
  return {
    id,
    name,
    weight,
    kind,
    bandThresholds: { fail: 40, pass: 65, excellent: 85 },
    anchors: { fail, pass, excellent },
    minEvidenceQuotes: minEvidence,
    autoScoreEnabled: true,
  };
}

function generalV2(): RubricCriterionV2[] {
  return [
    anchored("script_adherence", "Script adherence", "script_adherence", 15,
      "Skipped intro or qualification flow.", "Followed the standard flow.", "Followed flow and adapted naturally to the candidate.", 1),
    anchored("jd_coverage", "JD coverage", "jd_coverage", 25,
      "Did not probe must-have skills.", "Covered must-have skills.", "Covered must-haves and probed hands-on depth.", 2),
    anchored("salary_handling", "Compensation handling", "salary_handling", 20,
      "Did not state CTC band; pressured candidate.", "Stated band; captured current + expected.", "Stated band, captured both, handled the objection.", 2),
    anchored("positioning", "Client positioning", "positioning", 15,
      "No client context given.", "Gave client + role context.", "Positioned engineering culture and team scale.", 1),
    anchored("candidate_experience", "Candidate experience", "candidate_experience", 25,
      "Rushed; no space for questions.", "Gave the candidate space to ask.", "Handled objections openly and empathetically.", 1),
  ];
}

function technicalV2(): RubricCriterionV2[] {
  return [
    ...generalV2(),
    anchored("technical_depth", "Technical depth", "technical_depth", 30,
      "Surface-level questions only.", "Asked depth-appropriate questions.", "Layered probing with strong follow-ups.", 2),
  ];
}

async function writeAudit(
  rubricId: string,
  action: RubricAuditAction,
  actorUserId: string | null,
  createdAt: Date,
  extra: { fromVersion?: number; toVersion?: number; metadata?: Record<string, unknown>; rubricName?: string } = {},
) {
  await db.insert(rubricAuditLog).values({
    orgId: DEMO_ORG_ID,
    rubricId,
    rubricName: extra.rubricName ?? null,
    actorUserId,
    action,
    fromVersion: extra.fromVersion ?? null,
    toVersion: extra.toVersion ?? null,
    metadata: extra.metadata ?? {},
    createdAt,
  });
}

export async function seedDemoRubricExtras(ctx: DemoContext): Promise<void> {
  const admin = ctx.adminUserId || null;
  const qa = ctx.qaUserIds[0] ?? admin;

  // ---- 1. Upgrade + publish the 3 base rubrics ----
  const upgrades: Array<{ purpose: string; criteria: RubricCriterionV2[] }> = [
    { purpose: "general_screen", criteria: generalV2() },
    { purpose: "technical_screen", criteria: technicalV2() },
    { purpose: "senior_technical", criteria: technicalV2() },
  ];
  for (const u of upgrades) {
    const id = ctx.rubricIdByPurpose.get(u.purpose);
    if (!id) continue;
    await db
      .update(callRubrics)
      .set({
        criteria: u.criteria,
        status: "published",
        publishedVersion: 1,
        appliesTo: u.purpose === "general_screen" ? ["call", "coaching"] : ["call"],
        createdByUserId: admin,
        updatedByUserId: admin,
        description: `Default ${u.purpose.replace(/_/g, " ")} rubric with behavioral anchors.`,
      })
      .where(and(eq(callRubrics.id, id), eq(callRubrics.orgId, DEMO_ORG_ID)));

    await db
      .insert(callRubricVersions)
      .values({
        orgId: DEMO_ORG_ID,
        rubricId: id,
        version: 1,
        criteria: u.criteria,
        purpose: u.purpose as never,
        name: u.purpose.replace(/_/g, " "),
        publishedByUserId: admin,
        publishedAt: daysAgo(40),
        changeNote: "Initial published version.",
      })
      .onConflictDoNothing();

    await writeAudit(id, "created", admin, daysAgo(45), { metadata: { seeded: true } });
    await writeAudit(id, "updated", admin, daysAgo(42), { metadata: { changed: ["criteria"], seeded: true } });
    await writeAudit(id, "published", admin, daysAgo(40), { toVersion: 1, metadata: { seeded: true } });
    await writeAudit(id, "set_default", admin, daysAgo(40), { metadata: { seeded: true } });
  }

  // ---- 2. Five more rubrics across purposes/statuses ----
  const demoClientId = [...ctx.clientIdByName.values()][0] ?? null;

  const outboundCriteria: RubricCriterionV2[] = [
    anchored("positioning", "Opportunity pitch", "positioning", 40,
      "Generic pitch, no hook.", "Clear role + comp pitch.", "Tailored pitch tied to candidate motivations.", 1),
    anchored("candidate_experience", "Rapport & objection handling", "candidate_experience", 35,
      "Pushy; ignored hesitation.", "Acknowledged concerns.", "Turned objections into next steps.", 1),
    anchored("compliance_disclosure", "Disclosure", "compliance_disclosure", 25,
      "Misstated terms.", "Stated terms accurately.", "Proactively clarified PII handling.", 1),
  ];
  const hrCriteria: RubricCriterionV2[] = [
    anchored("salary_handling", "Comp & notice", "salary_handling", 50,
      "Did not capture notice/CTC.", "Captured notice + CTC.", "Captured both and flagged risks.", 2),
    anchored("candidate_experience", "Logistics & expectations", "candidate_experience", 50,
      "Vague on next steps.", "Set clear expectations.", "Aligned timeline and confirmed availability.", 1),
  ];

  const extras: Array<{
    name: string;
    purpose: string;
    status: "draft" | "published" | "archived";
    isDefault: boolean;
    appliesTo: string[];
    criteria: RubricCriterionV2[];
    clientId: string | null;
    archivedAt: Date | null;
    publishedVersion: number | null;
  }> = [
    { name: "Outbound Pitch — Standard", purpose: "outbound_pitch", status: "published", isDefault: true, appliesTo: ["call"], criteria: outboundCriteria, clientId: null, archivedAt: null, publishedVersion: 1 },
    { name: "HR Screen — Notice & Comp", purpose: "hr_screen", status: "published", isDefault: true, appliesTo: ["call"], criteria: hrCriteria, clientId: null, archivedAt: null, publishedVersion: 1 },
    { name: "Senior Architect — Deep Dive (draft)", purpose: "senior_technical", status: "draft", isDefault: false, appliesTo: ["call", "async_video"], criteria: technicalV2(), clientId: null, archivedAt: null, publishedVersion: null },
    { name: "Legacy General v0 (archived)", purpose: "general_screen", status: "archived", isDefault: false, appliesTo: ["call"], criteria: generalV2(), clientId: null, archivedAt: daysAgo(10), publishedVersion: null },
    { name: "Acme GCC — Client-Specific Tech", purpose: "technical_screen", status: "published", isDefault: false, appliesTo: ["call"], criteria: technicalV2(), clientId: demoClientId, archivedAt: null, publishedVersion: 1 },
  ];

  for (const e of extras) {
    const [row] = await db
      .insert(callRubrics)
      .values({
        orgId: DEMO_ORG_ID,
        name: e.name,
        version: e.publishedVersion ?? 1,
        purpose: e.purpose as never,
        clientId: e.clientId,
        appliesTo: e.appliesTo as never,
        status: e.status,
        publishedVersion: e.publishedVersion,
        isDefault: e.isDefault,
        criteria: e.criteria,
        archivedAt: e.archivedAt,
        createdByUserId: admin,
        updatedByUserId: admin,
        description: `${e.name} — seeded demo rubric.`,
        createdAt: daysAgo(35),
        updatedAt: e.archivedAt ?? daysAgo(5),
      })
      .returning({ id: callRubrics.id });

    if (e.publishedVersion) {
      await db
        .insert(callRubricVersions)
        .values({
          orgId: DEMO_ORG_ID,
          rubricId: row.id,
          version: e.publishedVersion,
          criteria: e.criteria,
          purpose: e.purpose as never,
          name: e.name,
          publishedByUserId: qa,
          publishedAt: daysAgo(30),
          changeNote: "Initial published version.",
        })
        .onConflictDoNothing();
    }

    await writeAudit(row.id, "created", admin, daysAgo(35), { metadata: { seeded: true } });
    if (e.publishedVersion) await writeAudit(row.id, "published", qa, daysAgo(30), { toVersion: e.publishedVersion, metadata: { seeded: true } });
    if (e.isDefault) await writeAudit(row.id, "set_default", admin, daysAgo(29), { metadata: { seeded: true } });
    if (e.status === "archived") await writeAudit(row.id, "archived", admin, e.archivedAt ?? daysAgo(10), { rubricName: e.name, metadata: { seeded: true } });
  }
}
