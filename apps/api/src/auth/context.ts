import { db, memberships, organizations, rolePermissions, type Role, users } from "@j2w/db";
import { and, eq } from "drizzle-orm";

/**
 * Sentinel orgId for platform admins. Distinct from DEFAULT_ORG_ID so that
 * tenant-route queries filtering by the platform admin's orgId match no real
 * data (defensive against leaks). Real /platform routes ignore the orgId and
 * gate on `isPlatformAdmin` instead.
 */
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
  /**
   * Super-admin flag. When true, orgId is the PLATFORM_ORG_ID sentinel and
   * `permissions` is empty — the user must be routed through /api/platform/*
   * via the requirePlatformAdmin middleware to do anything. Tenant routes
   * filtering by `req.authUser.orgId` will therefore see no data.
   */
  isPlatformAdmin: boolean;
}

/**
 * Fetch the user + their active membership + cached role permissions.
 * Returns null if the user is missing, the membership is missing, or either
 * is suspended.
 *
 * Platform admins (`users.is_platform_admin = true`) have no membership; they
 * get a sentinel AuthUser with `orgId = PLATFORM_ORG_ID` and an empty
 * permissions array. Tenant routes don't have to special-case them — queries
 * scoped to that sentinel id return nothing. Platform routes gate on
 * `isPlatformAdmin` via `requirePlatformAdmin`.
 *
 * For now a user has exactly one active membership (single workspace); this
 * shape leaves room to choose an active org later without API changes.
 */
export async function loadAuthUser(userId: string, orgId?: string): Promise<AuthUser | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || user.suspendedAt) return null;

  // Platform admins skip the membership check entirely.
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

  const [member] = orgId
    ? await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    : await db.select().from(memberships).where(eq(memberships.userId, userId));
  if (!member || member.status === "suspended") return null;

  const [org] = await db.select().from(organizations).where(eq(organizations.id, member.orgId));
  if (!org) return null;

  const perms = await db
    .select({ p: rolePermissions.permission })
    .from(rolePermissions)
    .where(and(eq(rolePermissions.orgId, member.orgId), eq(rolePermissions.role, member.role)));

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
    permissions: perms.map((p) => p.p),
    isPlatformAdmin: false,
  };
}
