import { collections } from "../mongo.js";

export type Role =
  | "recruiter"
  | "delivery_lead"
  | "account_manager"
  | "business_head"
  | "qa_reviewer"
  | "admin"
  | "client_user"
  | "proctor";

/** Sentinel orgId for platform admins (matches no real tenant data). */
export const PLATFORM_ORG_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  orgId: string;
  orgName: string;
  role: Role;
  membershipStatus: "invited" | "active" | "suspended";
  emailVerifiedAt: Date | null;
  mfaEnrolledAt: Date | null;
  suspendedAt: Date | null;
  permissions: string[];
  isPlatformAdmin: boolean;
}

interface UserDoc {
  id: string;
  email: string;
  name: string | null;
  suspendedAt: Date | null;
  isPlatformAdmin?: boolean;
  emailVerifiedAt: Date | null;
  mfaEnrolledAt: Date | null;
}
interface MembershipDoc { userId: string; orgId: string; role: Role; status: "invited" | "active" | "suspended"; }

/** Fetch the user + their active membership + cached role permissions (Mongo). */
export async function loadAuthUser(userId: string, orgId?: string): Promise<AuthUser | null> {
  const user = await collections.users().findOne<UserDoc>({ id: userId });
  if (!user || user.suspendedAt) return null;

  if (user.isPlatformAdmin) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      orgId: PLATFORM_ORG_ID,
      orgName: "Platform",
      role: "admin",
      membershipStatus: "active",
      emailVerifiedAt: user.emailVerifiedAt,
      mfaEnrolledAt: user.mfaEnrolledAt,
      suspendedAt: user.suspendedAt,
      permissions: [],
      isPlatformAdmin: true,
    };
  }

  const member = await collections.memberships().findOne<MembershipDoc>(
    orgId ? { userId, orgId } : { userId },
  );
  if (!member || member.status === "suspended") return null;

  const org = await collections.organizations().findOne<{ id: string; name: string }>({ id: member.orgId });
  if (!org) return null;

  const perms = await collections
    .rolePermissions()
    .find<{ permission: string }>({ orgId: member.orgId, role: member.role })
    .toArray();

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    orgId: org.id,
    orgName: org.name,
    role: member.role,
    membershipStatus: member.status,
    emailVerifiedAt: user.emailVerifiedAt,
    mfaEnrolledAt: user.mfaEnrolledAt,
    suspendedAt: user.suspendedAt,
    permissions: perms.map((p) => p.permission),
    isPlatformAdmin: false,
  };
}
