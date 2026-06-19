// Resume → structured fields via OpenAI structured outputs.
//
// Lazy OpenAI client (mirrors rag/suggest.ts). Throws ResumeExtractionError
// with code="openai_not_configured" when OPENAI_API_KEY is missing — the
// route handler maps that to 503. Throws code="extraction_failed" when both
// the primary model and the fallback fail to return parseable JSON.

import OpenAI from "openai";

// Read OpenAI config from process.env directly so this module can be used
// from any workspace (api, worker) without an env wrapper. Defaults match
// the api/src/env.ts defaults.
const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY;
const OPENAI_MODEL = () => process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const OPENAI_MODEL_FALLBACK = () =>
  process.env.OPENAI_MODEL_FALLBACK ?? "gpt-4o-mini";

export interface ParsedResumeSkill {
  name: string;
  yearsOfExperience: number | null;
}

export interface ParsedResumeExperience {
  companyName: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  description: string | null;
  location: string | null;
}

export interface ParsedResumeQualification {
  degree: string | null;
  institution: string | null;
  fieldOfStudy: string | null;
  yearOfCompletion: number | null;
  marksOrGrade: string | null;
}

export interface ParsedResume {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  totalExperienceYears: number | null;
  currentCtcLakhs: number | null;
  expectedCtcLakhs: number | null;
  noticePeriodDays: number | null;
  currentLocation: string | null;
  summary: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  skills: ParsedResumeSkill[];
  experiences: ParsedResumeExperience[];
  qualifications: ParsedResumeQualification[];
}

export interface ExtractionResult {
  parsed: ParsedResume;
  modelUsed: string;
}

export class ResumeExtractionError extends Error {
  code: "openai_not_configured" | "extraction_failed";
  constructor(code: ResumeExtractionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!OPENAI_API_KEY()) {
      throw new ResumeExtractionError("openai_not_configured", "OPENAI_API_KEY is not set");
    }
    _client = new OpenAI({ apiKey: OPENAI_API_KEY() });
  }
  return _client;
}

const SYSTEM_PROMPT = `You extract structured candidate data from a resume in the Indian recruiting context. Return strictly valid JSON matching the schema. Do not invent or infer data — when a field is not stated clearly, return null.

GUIDELINES — apply each one carefully.

1. Compensation (currentCtcLakhs, expectedCtcLakhs)
   Indian resumes denote compensation in lakhs (1 lakh = 100,000). Convert to a decimal number of lakhs.
   - "12 LPA" → 12
   - "12.5 LPA" → 12.5
   - "₹15,00,000" → 15
   - "INR 18 Lakh" → 18
   - "USD 80,000" → null (different currency, do not convert)
   - "Negotiable" → null
   If the resume mentions compensation in absolute INR (no LPA suffix), divide by 100,000 to get lakhs. Return null if currency is not INR or unstated.

2. Notice period (noticePeriodDays)
   Convert to integer days.
   - "Immediate" / "Already serving notice" / "0 days" → 0
   - "30 days" / "1 month" → 30
   - "60 days" / "2 months" → 60
   - "90 days" / "3 months" → 90
   Return null if the resume does not mention notice period.

3. Total experience (totalExperienceYears)
   The candidate's total professional experience as a decimal number of years.
   - "8 years 6 months" → 8.5
   - "10+ years" → 10
   - "Fresher" → 0
   If the resume lists experiences with start/end dates but no aggregate total, sum them yourself.

4. Phone (phone)
   Preserve as written. Do not normalize. The caller handles E.164 conversion.

5. Email (email)
   Lowercase but otherwise preserve. Pick the first email at the top of the resume; ignore reference emails buried in experience descriptions.

6. Skill names (skills[].name)
   Use canonical short forms. "Node.js" not "NodeJS" or "node js". "Spring Boot" not "spring boot framework". "PostgreSQL" not "Postgres" or "postgresql". "AWS" not "Amazon Web Services". Group platform skills under their canonical name.
   Skills should be technical / professional skills only — not soft skills like "Communication" or "Teamwork".

7. Experiences
   One entry per role / company. If the candidate had multiple titles at the same company, prefer one entry per title (with the title field reflecting the most recent / current one if you must collapse).
   - companyName: required, the employer name as it appears on the resume.
   - title: the job title for that stint.
   - startDate / endDate: format "YYYY-MM" if month is known, otherwise "YYYY". Null if unknown.
   - isCurrent: true ONLY if the resume marks this role as "Present" or "Current". Otherwise false.
   - endDate: null when isCurrent is true.
   - description: 1-3 sentences distilled from the bullets, or null if no description text.
   - location: city / city,state if mentioned in the experience entry; otherwise null.
   List experiences from MOST RECENT first.

8. Qualifications
   Education entries — degrees, diplomas, certifications.
   - degree: e.g. "B.Tech", "MBA", "M.Sc"
   - institution: the school / university name.
   - fieldOfStudy: e.g. "Computer Science", "Electrical Engineering". Null for general degrees.
   - yearOfCompletion: graduation year as integer. Null if not stated.
   - marksOrGrade: CGPA / percentage / grade as written ("8.4 CGPA", "78%", "First Class").

9. Links (linkedinUrl, githubUrl)
   Full URL with scheme. Strip query strings if present. Null if not on the resume.
   - "linkedin.com/in/foo" → "https://linkedin.com/in/foo"
   - "github.com/foo" → "https://github.com/foo"

10. Summary
    A 2-4 sentence professional summary distilled from the top of the resume / objective / "About" section. If the resume has no summary section, synthesize one from the most recent role + total experience + key skills. Cap at 4000 chars.

EXAMPLE INPUT (excerpted resume text):
"""
PRIYA SHARMA
Senior Software Engineer | priya.sharma@example.com | +91-98765-43210 | Bengaluru, Karnataka
linkedin.com/in/priya-sharma | github.com/priyasharma

Summary
Backend engineer with 7+ years building distributed systems for fintech and e-commerce. Strong in Go, Java, and AWS infrastructure.

Experience
- Razorpay (Apr 2022 - Present), Senior Software Engineer, Bengaluru
  Built the merchant payouts pipeline. Tech: Go, Kafka, PostgreSQL.
- Flipkart (Jul 2018 - Mar 2022), SDE-II, Bengaluru
  Owned the search ranking microservice. Tech: Java, Spring Boot, Elasticsearch.

Education
- B.Tech in Computer Science, IIT Bombay, 2018, 8.7 CGPA

Compensation
Current CTC: 32 LPA. Expected: 42 LPA. Notice period: 60 days (negotiable).

Skills: Go, Java, Spring Boot, Kafka, PostgreSQL, AWS, Kubernetes, Docker
"""

EXAMPLE OUTPUT:
{
  "firstName": "Priya",
  "lastName": "Sharma",
  "email": "priya.sharma@example.com",
  "phone": "+91-98765-43210",
  "currentTitle": "Senior Software Engineer",
  "currentCompany": "Razorpay",
  "totalExperienceYears": 7,
  "currentCtcLakhs": 32,
  "expectedCtcLakhs": 42,
  "noticePeriodDays": 60,
  "currentLocation": "Bengaluru, Karnataka",
  "summary": "Backend engineer with 7+ years building distributed systems for fintech and e-commerce. Strong in Go, Java, and AWS infrastructure.",
  "linkedinUrl": "https://linkedin.com/in/priya-sharma",
  "githubUrl": "https://github.com/priyasharma",
  "skills": [
    {"name": "Go", "yearsOfExperience": null},
    {"name": "Java", "yearsOfExperience": null},
    {"name": "Spring Boot", "yearsOfExperience": null},
    {"name": "Kafka", "yearsOfExperience": null},
    {"name": "PostgreSQL", "yearsOfExperience": null},
    {"name": "AWS", "yearsOfExperience": null},
    {"name": "Kubernetes", "yearsOfExperience": null},
    {"name": "Docker", "yearsOfExperience": null}
  ],
  "experiences": [
    {
      "companyName": "Razorpay",
      "title": "Senior Software Engineer",
      "startDate": "2022-04",
      "endDate": null,
      "isCurrent": true,
      "description": "Built the merchant payouts pipeline using Go, Kafka, and PostgreSQL.",
      "location": "Bengaluru"
    },
    {
      "companyName": "Flipkart",
      "title": "SDE-II",
      "startDate": "2018-07",
      "endDate": "2022-03",
      "isCurrent": false,
      "description": "Owned the search ranking microservice using Java, Spring Boot, and Elasticsearch.",
      "location": "Bengaluru"
    }
  ],
  "qualifications": [
    {
      "degree": "B.Tech",
      "institution": "IIT Bombay",
      "fieldOfStudy": "Computer Science",
      "yearOfCompletion": 2018,
      "marksOrGrade": "8.7 CGPA"
    }
  ]
}

If the resume is empty, garbled, or you cannot extract anything, return all fields as null and arrays as []. Do not refuse — return the schema with empty values.`;

const JSON_SCHEMA = {
  name: "resume_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "firstName",
      "lastName",
      "email",
      "phone",
      "currentTitle",
      "currentCompany",
      "totalExperienceYears",
      "currentCtcLakhs",
      "expectedCtcLakhs",
      "noticePeriodDays",
      "currentLocation",
      "summary",
      "linkedinUrl",
      "githubUrl",
      "skills",
      "experiences",
      "qualifications",
    ],
    properties: {
      firstName: { type: ["string", "null"] },
      lastName: { type: ["string", "null"] },
      email: { type: ["string", "null"] },
      phone: { type: ["string", "null"] },
      currentTitle: { type: ["string", "null"] },
      currentCompany: { type: ["string", "null"] },
      totalExperienceYears: { type: ["number", "null"] },
      currentCtcLakhs: { type: ["number", "null"] },
      expectedCtcLakhs: { type: ["number", "null"] },
      noticePeriodDays: { type: ["integer", "null"] },
      currentLocation: { type: ["string", "null"] },
      summary: { type: ["string", "null"] },
      linkedinUrl: { type: ["string", "null"] },
      githubUrl: { type: ["string", "null"] },
      skills: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "yearsOfExperience"],
          properties: {
            name: { type: "string" },
            yearsOfExperience: { type: ["number", "null"] },
          },
        },
      },
      experiences: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["companyName", "title", "startDate", "endDate", "isCurrent", "description", "location"],
          properties: {
            companyName: { type: "string" },
            title: { type: ["string", "null"] },
            startDate: { type: ["string", "null"] },
            endDate: { type: ["string", "null"] },
            isCurrent: { type: "boolean" },
            description: { type: ["string", "null"] },
            location: { type: ["string", "null"] },
          },
        },
      },
      qualifications: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["degree", "institution", "fieldOfStudy", "yearOfCompletion", "marksOrGrade"],
          properties: {
            degree: { type: ["string", "null"] },
            institution: { type: ["string", "null"] },
            fieldOfStudy: { type: ["string", "null"] },
            yearOfCompletion: { type: ["integer", "null"] },
            marksOrGrade: { type: ["string", "null"] },
          },
        },
      },
    },
  },
} as const;

const MAX_INPUT_CHARS = 30_000;

interface Logger {
  info: (msg: unknown, ...rest: unknown[]) => void;
  warn: (msg: unknown, ...rest: unknown[]) => void;
  error: (msg: unknown, ...rest: unknown[]) => void;
}

export async function extractResumeFields(text: string, log?: Logger): Promise<ExtractionResult> {
  const c = client();
  const trimmed = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: trimmed },
  ];

  const tryWithModel = async (model: string): Promise<ParsedResume> => {
    const completion = await c.chat.completions.create({
      model,
      messages,
      response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
      temperature: 0.1,
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("empty_completion");
    return JSON.parse(raw) as ParsedResume;
  };

  try {
    const parsed = await tryWithModel(OPENAI_MODEL());
    return { parsed, modelUsed: OPENAI_MODEL() };
  } catch (e) {
    log?.warn?.({ err: (e as Error).message, model: OPENAI_MODEL() }, "resume_extract_primary_failed");
    try {
      const parsed = await tryWithModel(OPENAI_MODEL_FALLBACK());
      return { parsed, modelUsed: OPENAI_MODEL_FALLBACK() };
    } catch (e2) {
      log?.error?.({ err: (e2 as Error).message, model: OPENAI_MODEL_FALLBACK() }, "resume_extract_fallback_failed");
      throw new ResumeExtractionError("extraction_failed", (e2 as Error).message);
    }
  }
}
