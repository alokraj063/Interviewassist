// Deterministic fake-candidate connector. Used as the default fallback so
// the Sourcing UI works end-to-end without real API keys, and as the
// canonical reference for what real connectors should return.
import type {
  CandidatePreview,
  Connector,
  ConnectorHealth,
  PullCandidatesQuery,
  PushPlacementInput,
} from "./types.js";

const SAMPLE_NAMES = [
  "Aarav Sharma",
  "Priya Reddy",
  "Vikram Iyer",
  "Sneha Patel",
  "Rohan Gupta",
  "Aisha Khan",
  "Karthik Nair",
  "Meera Joshi",
  "Arjun Desai",
  "Divya Menon",
];

const SAMPLE_COMPANIES = [
  "Razorpay",
  "Flipkart",
  "Swiggy",
  "Zomato",
  "Cred",
  "Ola",
  "PhonePe",
  "Meesho",
  "Dream11",
  "Pine Labs",
];

const SAMPLE_TITLES = [
  "Senior Software Engineer",
  "Backend Engineer",
  "Frontend Engineer",
  "Full Stack Engineer",
  "Engineering Manager",
  "Tech Lead",
  "SDE-II",
  "SDE-III",
  "Staff Engineer",
];

const SAMPLE_SKILLS = [
  ["React", "TypeScript", "Node.js"],
  ["Java", "Spring Boot", "Kafka"],
  ["Go", "Kubernetes", "PostgreSQL"],
  ["Python", "Django", "AWS"],
  ["React Native", "Swift", "Kotlin"],
  ["AWS", "Terraform", "Linux"],
  ["Scala", "Spark", "Airflow"],
];

const SAMPLE_LOCATIONS = [
  "Bengaluru",
  "Hyderabad",
  "Pune",
  "Mumbai",
  "Delhi NCR",
  "Chennai",
];

function pseudoRandom(seedStr: string): () => number {
  // Mulberry32 from a string hash so the same seed = same fake-candidate set
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createMockConnector(key = "mock", displayName = "Mock"): Connector {
  return {
    key,
    displayName,
    async health(): Promise<ConnectorHealth> {
      return { ok: true };
    },
    async pullCandidates(q: PullCandidatesQuery): Promise<CandidatePreview[]> {
      const limit = Math.min(q.limit ?? 12, 50);
      const seed = `${key}|${q.q ?? ""}|${q.skill ?? ""}|${q.location ?? ""}`;
      const rnd = pseudoRandom(seed);
      const out: CandidatePreview[] = [];
      for (let i = 0; i < limit; i++) {
        const name = SAMPLE_NAMES[Math.floor(rnd() * SAMPLE_NAMES.length)];
        const title = SAMPLE_TITLES[Math.floor(rnd() * SAMPLE_TITLES.length)];
        const company = SAMPLE_COMPANIES[Math.floor(rnd() * SAMPLE_COMPANIES.length)];
        const skills = SAMPLE_SKILLS[Math.floor(rnd() * SAMPLE_SKILLS.length)];
        const loc = q.location ?? SAMPLE_LOCATIONS[Math.floor(rnd() * SAMPLE_LOCATIONS.length)];
        const exp = Math.round((q.minExperienceYears ?? 2) + rnd() * 8);
        const expectedCtc = 8 + Math.round(rnd() * 32);
        const notice = [0, 30, 60, 90][Math.floor(rnd() * 4)];
        out.push({
          externalId: `${key}-${seed.length}-${i}`,
          source: key,
          displayName: name,
          email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
          phone: null,
          currentTitle: title,
          currentCompany: company,
          totalExperienceYears: exp,
          expectedCtcLakhs: expectedCtc,
          noticePeriodDays: notice,
          currentLocation: loc,
          skills,
          rawProfileUrl: `https://example.com/${key}/${i}`,
          fetchedAt: new Date().toISOString(),
        });
      }
      return out;
    },
    async pushPlacement(_p: PushPlacementInput) {
      return { ok: true, remoteId: `mock-${Date.now()}` };
    },
  };
}

export const mockConnector = createMockConnector();
