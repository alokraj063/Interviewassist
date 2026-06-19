// Shared context handed phase-to-phase so each module sees the IDs the prior
// phase produced. Keeps modules from re-querying the same ids on every step.

export interface UserSpec {
  email: string;
  name: string;
  role:
    | "recruiter"
    | "delivery_lead"
    | "account_manager"
    | "business_head"
    | "qa_reviewer"
    | "admin"
    | "client_user"
    | "proctor";
  jobTitle: string;
  reportingToEmail?: string;
}

export interface DemoContext {
  // Identity
  userIdByEmail: Map<string, string>;
  recruiterUserIds: string[];
  qaUserIds: string[];
  deliveryLeadUserIds: string[];
  accountManagerUserIds: string[];
  proctorUserIds: string[];
  clientUserIds: string[];
  adminUserId: string;

  // Taxonomy
  skillIdByName: Map<string, string>;
  locationIdByCity: Map<string, string>;
  industryIdByName: Map<string, string>;
  functionalAreaIdByName: Map<string, string>;
  roleCategoryIdByName: Map<string, string>;
  jobRoleIdByName: Map<string, string>;

  // Pipeline
  clientIdByName: Map<string, string>;
  demandIds: string[];
  demandIdByTitle: Map<string, string>;
  candidateIds: string[];
  candidateIdByEmail: Map<string, string>;
  prospectIds: string[];
  submissionIds: string[];

  // Calls
  callIds: string[];
  rubricIdByPurpose: Map<string, string>;

  // Voice agents
  voiceAgentIdByName: Map<string, string>;

  // Question banks
  questionBankIdByName: Map<string, string>;
}

export function emptyContext(): DemoContext {
  return {
    userIdByEmail: new Map(),
    recruiterUserIds: [],
    qaUserIds: [],
    deliveryLeadUserIds: [],
    accountManagerUserIds: [],
    proctorUserIds: [],
    clientUserIds: [],
    adminUserId: "",
    skillIdByName: new Map(),
    locationIdByCity: new Map(),
    industryIdByName: new Map(),
    functionalAreaIdByName: new Map(),
    roleCategoryIdByName: new Map(),
    jobRoleIdByName: new Map(),
    clientIdByName: new Map(),
    demandIds: [],
    demandIdByTitle: new Map(),
    candidateIds: [],
    candidateIdByEmail: new Map(),
    prospectIds: [],
    submissionIds: [],
    callIds: [],
    rubricIdByPurpose: new Map(),
    voiceAgentIdByName: new Map(),
    questionBankIdByName: new Map(),
  };
}
