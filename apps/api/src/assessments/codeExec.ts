// Code-execution sandbox bridge for `coding` assessment items.
//
// Real path: POSTs each test case to a Judge0 endpoint (self-host or RapidAPI)
// behind env.JUDGE0_URL (+ optional JUDGE0_AUTH_TOKEN). Hidden test cases never
// leak to the candidate — only the aggregate {passed,total} is returned.
//
// Stub fallback: when JUDGE0_URL is unset, runCode() returns a `configured:false`
// result so the caller can route coding items to the manual-review queue and the
// dedicated /attempts/:id/run-code endpoint can answer 503 (never 500).
import { env } from "../env.js";

export interface CodeTestCase {
  id: string;
  stdin?: string;
  expected: string;
  hidden?: boolean;
  weight?: number;
}

export interface CodeRunResult {
  configured: boolean;
  passed: number;
  total: number;
  // per-test outcome, redacted of hidden expected values for candidate display.
  cases: Array<{ id: string; passed: boolean; hidden: boolean; weight: number }>;
  stderr?: string;
}

// Judge0 language ids for the languages our builder offers. Self-hosted Judge0
// ships these ids by default; RapidAPI mirrors them.
const JUDGE0_LANGUAGE_IDS: Record<string, number> = {
  python: 71, // Python 3.8
  javascript: 63, // Node 12
  java: 62, // Java OpenJDK 13
  cpp: 54, // C++ GCC 9
  go: 60, // Go 1.13
};

export function isCodeExecConfigured(): boolean {
  return !!env.JUDGE0_URL;
}

/**
 * Run a candidate's source against the item's test cases. Returns
 * `configured:false` (and never throws) when the sandbox is unset so callers
 * degrade to manual review. The caller decides how `passed/total` maps to
 * awarded points (weighted by the per-case weight).
 */
export async function runCode(args: {
  language: string;
  source: string;
  testCases: CodeTestCase[];
  timeoutMs?: number;
}): Promise<CodeRunResult> {
  const { language, source, testCases } = args;
  const total = testCases.length;
  if (!env.JUDGE0_URL) {
    return {
      configured: false,
      passed: 0,
      total,
      cases: testCases.map((t) => ({
        id: t.id,
        passed: false,
        hidden: !!t.hidden,
        weight: t.weight ?? 1,
      })),
    };
  }

  const langId = JUDGE0_LANGUAGE_IDS[language];
  if (langId === undefined) {
    return {
      configured: true,
      passed: 0,
      total,
      cases: testCases.map((t) => ({ id: t.id, passed: false, hidden: !!t.hidden, weight: t.weight ?? 1 })),
      stderr: `unsupported_language:${language}`,
    };
  }

  const base = env.JUDGE0_URL.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.JUDGE0_AUTH_TOKEN) headers["X-Auth-Token"] = env.JUDGE0_AUTH_TOKEN;

  const cases: CodeRunResult["cases"] = [];
  let passed = 0;
  let stderr: string | undefined;

  for (const tc of testCases) {
    try {
      const res = await fetch(`${base}/submissions?base64_encoded=false&wait=true`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          language_id: langId,
          source_code: source,
          stdin: tc.stdin ?? "",
          expected_output: tc.expected,
          cpu_time_limit: Math.max(1, Math.round((args.timeoutMs ?? 5000) / 1000)),
        }),
      });
      if (!res.ok) {
        cases.push({ id: tc.id, passed: false, hidden: !!tc.hidden, weight: tc.weight ?? 1 });
        stderr = stderr ?? `judge0_http_${res.status}`;
        continue;
      }
      const body = (await res.json()) as {
        status?: { id: number; description: string };
        stdout?: string | null;
        stderr?: string | null;
      };
      // Judge0 status id 3 = "Accepted" (stdout matched expected_output).
      const ok = body.status?.id === 3;
      if (ok) passed += 1;
      if (body.stderr && !stderr) stderr = body.stderr.slice(0, 500);
      cases.push({ id: tc.id, passed: ok, hidden: !!tc.hidden, weight: tc.weight ?? 1 });
    } catch (err) {
      cases.push({ id: tc.id, passed: false, hidden: !!tc.hidden, weight: tc.weight ?? 1 });
      stderr = stderr ?? (err instanceof Error ? err.message : "judge0_error");
    }
  }

  return { configured: true, passed, total, cases, stderr };
}
