// Compiles a coaching scenario's structured persona into an AI-candidate
// system prompt + opening line, so the recruiter practices against a candidate
// driven by THIS scenario (not the hardcoded "Aarav" demo persona in
// live-assist.ts). Returned shape feeds the Vapi assistant block built by the
// AI-roleplay route.
import type { CoachingPersona } from "@j2w/db";

export type ScenarioForPrompt = {
  title: string;
  description?: string | null;
  candidatePersona?: CoachingPersona | null;
  objections?: string[] | null;
  openingLine?: string | null;
  language?: string | null;
};

const LANG_HINT: Record<string, string> = {
  hinglish: "Speak in natural Hinglish (Hindi-English code-mix), like an urban Indian professional.",
  "en-IN": "Speak in Indian English.",
  "hi-IN": "Speak primarily in Hindi.",
};

export function buildPersonaSystemPrompt(scenario: ScenarioForPrompt): {
  systemPrompt: string;
  firstMessage: string;
} {
  const p = scenario.candidatePersona ?? {};
  const name = p.candidateName ?? "the candidate";
  const lines: string[] = [
    `You are role-playing a job CANDIDATE named ${name} on a phone call with a recruiter.`,
    `This is a practice simulation: the recruiter is being coached. Stay fully in character as the candidate — never break character, never coach.`,
    LANG_HINT[scenario.language ?? "hinglish"] ?? LANG_HINT.hinglish,
  ];
  if (p.candidateRole) lines.push(`Your current role: ${p.candidateRole}.`);
  if (p.currentCompany) lines.push(`Your current company: ${p.currentCompany}.`);
  if (typeof p.yearsExperience === "number") lines.push(`Years of experience: ${p.yearsExperience}.`);
  if (typeof p.currentCtcLakhs === "number") lines.push(`Current CTC: ${p.currentCtcLakhs} LPA.`);
  if (typeof p.expectedCtcLakhs === "number") lines.push(`Expected CTC: ${p.expectedCtcLakhs} LPA.`);
  if (typeof p.noticePeriodDays === "number") lines.push(`Notice period: ${p.noticePeriodDays} days.`);
  if (p.location) lines.push(`Location: ${p.location}.`);
  if (p.mood) lines.push(`Your mood/demeanor: ${p.mood}.`);
  if (p.speakingStyle) lines.push(`Speaking style: ${p.speakingStyle}.`);
  if (p.resistance) lines.push(`Resistance level (how much you push back): ${p.resistance}.`);
  if (p.hiddenContext) {
    lines.push(
      `HIDDEN CONTEXT (do NOT volunteer; only reveal if the recruiter probes well): ${p.hiddenContext}`,
    );
  }
  const objections = scenario.objections ?? [];
  if (objections.length > 0) {
    lines.push(`Raise these objections naturally during the call when relevant:`);
    for (const o of objections) lines.push(`  - "${o}"`);
  }
  if (p.redFlags && p.redFlags.length > 0) {
    lines.push(`Subtly exhibit these traits if the recruiter digs: ${p.redFlags.join("; ")}.`);
  }
  lines.push(`Keep responses conversational and concise (1-3 sentences). End the call politely if the recruiter wraps up.`);

  const firstMessage =
    scenario.openingLine?.trim() ||
    p.openingLine?.trim() ||
    "Haan ji, boliye — aap kis role ke baare mein baat karna chahte the?";

  return { systemPrompt: lines.join("\n"), firstMessage };
}
