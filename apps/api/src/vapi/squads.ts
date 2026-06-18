// Build/refresh the Vapi squad backing a triage flow. Each triage flow's
// rules with destinationType='voice_agent' contribute one squad member.
// On deploy of a triage agent we sync the squad so warm transfer can switch
// the active member without creating a new call leg.
//
// Vapi's squad model: { name, members: [{ assistantId, assistantOverrides? }] }
// where the FIRST member is the entry assistant (our triage agent). Adding/
// removing members is done via PATCH /squad/:id with the full members array.

import { eq } from "drizzle-orm";
import { db, voiceAgents } from "@j2w/db";
import type { TriageRoutingRule } from "@j2w/shared-types";
import { createSquad, updateSquad } from "./client.js";

export interface SyncSquadResult {
  squadId: string;
  memberCount: number;
}

export async function syncTriageSquad(
  triageAgent: { id: string; name: string; vapiAssistantId: string | null; vapiSquadId: string | null },
  rules: TriageRoutingRule[],
): Promise<SyncSquadResult | null> {
  if (!triageAgent.vapiAssistantId) return null;

  // Resolve specialist Vapi assistant ids for every voice_agent destination.
  // We only include rules that are enabled — disabled rules shouldn't have a
  // squad slot keeping a stale assistant alive.
  const targetIds = Array.from(
    new Set(
      rules
        .filter((r) => r.enabled && r.destinationType === "voice_agent")
        .map((r) => r.destinationRef),
    ),
  );

  const targets = targetIds.length
    ? await db
        .select({ id: voiceAgents.id, vapiAssistantId: voiceAgents.vapiAssistantId })
        .from(voiceAgents)
        .where(eq(voiceAgents.orgId, voiceAgents.orgId)) // noop org filter; resolution by id below
    : [];

  const idToVapi = new Map(targets.map((t) => [t.id, t.vapiAssistantId]));
  const memberAssistantIds = targetIds
    .map((id) => idToVapi.get(id))
    .filter((v): v is string => !!v);

  // Triage agent is always member 0 (the call entry point).
  const members = [
    { assistantId: triageAgent.vapiAssistantId },
    ...memberAssistantIds.map((assistantId) => ({ assistantId })),
  ];

  const payload = {
    name: `triage:${triageAgent.id}`,
    members,
  };

  if (triageAgent.vapiSquadId) {
    await updateSquad(triageAgent.vapiSquadId, payload);
    return { squadId: triageAgent.vapiSquadId, memberCount: members.length };
  }

  const created = await createSquad(payload);
  return { squadId: created.id, memberCount: members.length };
}
