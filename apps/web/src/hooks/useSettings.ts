import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// -------- Users / invitations --------
export interface OrgUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  lastActiveAt: string | null;
  role: "agent" | "team_lead" | "manager" | "qa_reviewer" | "admin";
  status: "invited" | "active" | "suspended";
  invitedAt: string | null;
  joinedAt: string | null;
  teams: { id: string; name: string }[];
}

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<{ users: OrgUser[] }>("/api/users"),
    select: (d) => d.users,
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: OrgUser["role"]; teamId?: string }) =>
      apiFetch<{ invitationId: string }>("/api/users/invite", { method: "POST", json: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["invitations"] });
    },
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; role?: OrgUser["role"]; teamIds?: string[]; name?: string }) =>
      apiFetch(`/api/users/${input.id}`, { method: "PATCH", json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useSuspendUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/users/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export interface Invitation {
  id: string;
  email: string;
  role: OrgUser["role"];
  teamId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export function useInvitations() {
  return useQuery({
    queryKey: ["invitations"],
    queryFn: () => apiFetch<{ invitations: Invitation[] }>("/api/users/invitations"),
    select: (d) => d.invitations,
  });
}

export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/users/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invitations"] }),
  });
}

// -------- Profile --------
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<{ name: string; jobTitle: string; timezone: string; locale: string; avatarUrl: string }>) =>
      apiFetch("/api/users/me", { method: "PATCH", json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
}

// -------- Teams --------
export interface Team {
  id: string;
  name: string;
  managerUserId: string | null;
  createdAt: string;
  members: { id: string; name: string | null; email: string; avatarUrl: string | null }[];
}

export function useTeams() {
  return useQuery({
    queryKey: ["teams"],
    queryFn: () => apiFetch<{ teams: Team[] }>("/api/teams"),
    select: (d) => d.teams,
  });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; managerUserId?: string | null }) =>
      apiFetch<{ id: string }>("/api/teams", { method: "POST", json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
}

export function useUpdateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; name?: string; managerUserId?: string | null }) =>
      apiFetch(`/api/teams/${input.id}`, { method: "PATCH", json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/teams/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
}

export function useAddTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { teamId: string; userId: string }) =>
      apiFetch(`/api/teams/${input.teamId}/members`, { method: "POST", json: { userId: input.userId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
}

export function useRemoveTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { teamId: string; userId: string }) =>
      apiFetch(`/api/teams/${input.teamId}/members/${input.userId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
}

// -------- Roles matrix --------
export interface RolePermissions {
  roles: string[];
  permissions: string[];
  matrix: Record<string, string[]>;
}

export function useRolePermissions() {
  return useQuery({
    queryKey: ["rolePermissions"],
    queryFn: () => apiFetch<RolePermissions>("/api/roles/permissions"),
  });
}

export function useUpdateRolePermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (matrix: Record<string, string[]>) =>
      apiFetch("/api/roles/permissions", { method: "PATCH", json: { matrix } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rolePermissions"] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

// -------- Org --------
export interface Organization {
  id: string;
  name: string;
  slug: string;
  subdomain: string | null;
  defaultLocale: string | null;
  defaultTimezone: string | null;
  fiscalYearStart: string | null;
  businessHours: unknown;
}

export function useOrg() {
  return useQuery({
    queryKey: ["org"],
    queryFn: () => apiFetch<{ org: Organization }>("/api/org"),
    select: (d) => d.org,
  });
}

export function useUpdateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<Organization>) => apiFetch("/api/org", { method: "PATCH", json: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org"] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}
