import { randomUUID } from 'node:crypto';
import {
  AddProjectMemberInputSchema,
  canRolePerform,
  CreateProjectInputSchema,
  err,
  ok,
  ProjectMemberSchema,
  ProjectSchema,
  UpdateProjectInputSchema,
  UpdateProjectMemberRoleInputSchema,
  UuidSchema,
  type AddProjectMemberInput,
  type Project,
  type ProjectAction,
  type ProjectMember,
  type ProjectRole,
  type Result,
  type UpdateProjectInput,
  type UpdateProjectMemberRoleInput,
} from '@sunrise/shared';
import type { z } from 'zod';

export interface ProjectUserSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

export interface StoredProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ownerId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredMemberRecord {
  readonly projectId: string;
  readonly userId: string;
  readonly role: ProjectRole;
  readonly addedAt: string;
}

export interface ProjectRepository {
  readonly findUserById: (userId: string) => Promise<ProjectUserSummary | null>;
  readonly findUserByEmail: (email: string) => Promise<ProjectUserSummary | null>;
  readonly createProject: (
    project: StoredProjectRecord,
    ownerMember: StoredMemberRecord,
  ) => Promise<void>;
  readonly findProjectById: (projectId: string) => Promise<StoredProjectRecord | null>;
  readonly updateProject: (
    projectId: string,
    patch: { readonly name?: string; readonly description?: string; readonly updatedAt: string },
  ) => Promise<StoredProjectRecord | null>;
  readonly deleteProject: (projectId: string) => Promise<boolean>;
  readonly listUserProjects: (
    userId: string,
  ) => Promise<
    ReadonlyArray<{ readonly project: StoredProjectRecord; readonly role: ProjectRole }>
  >;
  readonly findMember: (projectId: string, userId: string) => Promise<StoredMemberRecord | null>;
  readonly upsertMember: (member: StoredMemberRecord) => Promise<void>;
  readonly removeMember: (projectId: string, userId: string) => Promise<boolean>;
  readonly listMembers: (projectId: string) => Promise<ReadonlyArray<StoredMemberRecord>>;
}

export interface ProjectService {
  readonly createProject: (
    actorUserId: string,
    input: { readonly name: string; readonly description?: string },
  ) => Promise<Result<Project>>;
  readonly listProjects: (actorUserId: string) => Promise<Result<Project[]>>;
  readonly getProject: (actorUserId: string, projectId: string) => Promise<Result<Project>>;
  readonly updateProject: (
    actorUserId: string,
    projectId: string,
    input: UpdateProjectInput,
  ) => Promise<Result<Project>>;
  readonly deleteProject: (
    actorUserId: string,
    projectId: string,
  ) => Promise<Result<{ readonly deleted: true }>>;
  readonly addMember: (
    actorUserId: string,
    projectId: string,
    input: AddProjectMemberInput,
  ) => Promise<Result<ProjectMember>>;
  readonly updateMemberRole: (
    actorUserId: string,
    projectId: string,
    targetUserId: string,
    input: UpdateProjectMemberRoleInput,
  ) => Promise<Result<ProjectMember>>;
  readonly removeMember: (
    actorUserId: string,
    projectId: string,
    targetUserId: string,
  ) => Promise<Result<{ readonly removed: true }>>;
  readonly listMembers: (
    actorUserId: string,
    projectId: string,
  ) => Promise<Result<ProjectMember[]>>;
  readonly assertAccess: (
    actorUserId: string,
    projectId: string,
    action: ProjectAction,
  ) => Promise<Result<{ readonly allowed: true; readonly role: ProjectRole }>>;
}

function formatZodIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0]?.message;
  return issue && issue.trim().length > 0 ? issue.trim().slice(0, 500) : fallback;
}

function toProjectDto(record: StoredProjectRecord, role: ProjectRole): Project {
  return ProjectSchema.parse({ ...record, role });
}

function toMemberDto(member: StoredMemberRecord, user: ProjectUserSummary): ProjectMember {
  return ProjectMemberSchema.parse({
    projectId: member.projectId,
    userId: member.userId,
    email: user.email,
    displayName: user.displayName,
    role: member.role,
    addedAt: member.addedAt,
  });
}

async function checkMembershipAccess(
  repo: ProjectRepository,
  actorUserId: string,
  projectId: string,
  action: ProjectAction,
): Promise<Result<{ readonly allowed: true; readonly role: ProjectRole }>> {
  if (!UuidSchema.safeParse(actorUserId).success || !UuidSchema.safeParse(projectId).success) {
    return err({ code: 'VALIDATION_ERROR', message: 'Invalid userId or projectId' });
  }
  const member = await repo.findMember(projectId, actorUserId);
  if (!member) {
    return err({ code: 'FORBIDDEN', message: 'User is not a member of this project' });
  }
  if (!canRolePerform(member.role, action)) {
    return err({
      code: 'FORBIDDEN',
      message: `Role "${member.role}" is not permitted to perform "${action}"`,
    });
  }
  return ok({ allowed: true, role: member.role });
}

export function createInMemoryProjectRepository(
  users: ReadonlyArray<ProjectUserSummary>,
): ProjectRepository {
  const usersById = new Map<string, ProjectUserSummary>();
  const usersByEmail = new Map<string, ProjectUserSummary>();
  const projectsById = new Map<string, StoredProjectRecord>();
  const membersByProject = new Map<string, Map<string, StoredMemberRecord>>();

  for (const user of users) {
    const normalized = { ...user, email: user.email.trim().toLowerCase() };
    usersById.set(normalized.id, normalized);
    usersByEmail.set(normalized.email, normalized);
  }

  return {
    findUserById: async (userId) => usersById.get(userId) ?? null,
    findUserByEmail: async (email) => usersByEmail.get(email.trim().toLowerCase()) ?? null,
    createProject: async (project, ownerMember) => {
      projectsById.set(project.id, project);
      const map = new Map<string, StoredMemberRecord>();
      map.set(ownerMember.userId, ownerMember);
      membersByProject.set(project.id, map);
    },
    findProjectById: async (projectId) => projectsById.get(projectId) ?? null,
    updateProject: async (projectId, patch) => {
      const existing = projectsById.get(projectId);
      if (!existing) {
        return null;
      }
      const updated: StoredProjectRecord = {
        ...existing,
        name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
        updatedAt: patch.updatedAt,
      };
      projectsById.set(projectId, updated);
      return updated;
    },
    deleteProject: async (projectId) => {
      membersByProject.delete(projectId);
      return projectsById.delete(projectId);
    },
    listUserProjects: async (userId) => {
      const results: Array<{ readonly project: StoredProjectRecord; readonly role: ProjectRole }> =
        [];
      for (const [projectId, memberMap] of membersByProject.entries()) {
        const membership = memberMap.get(userId);
        const project = projectsById.get(projectId);
        if (membership && project) {
          results.push({ project, role: membership.role });
        }
      }
      return results;
    },
    findMember: async (projectId, userId) => membersByProject.get(projectId)?.get(userId) ?? null,
    upsertMember: async (member) => {
      const map = membersByProject.get(member.projectId) ?? new Map<string, StoredMemberRecord>();
      map.set(member.userId, member);
      membersByProject.set(member.projectId, map);
    },
    removeMember: async (projectId, userId) =>
      membersByProject.get(projectId)?.delete(userId) ?? false,
    listMembers: async (projectId) => Array.from(membersByProject.get(projectId)?.values() ?? []),
  };
}

export function createProjectService(
  repo: ProjectRepository,
  now: () => Date = () => new Date(),
): ProjectService {
  return {
    createProject: async (actorUserId, input): Promise<Result<Project>> => {
      if (!UuidSchema.safeParse(actorUserId).success) {
        return err({ code: 'UNAUTHORIZED', message: 'Valid authenticated actor is required' });
      }
      const actor = await repo.findUserById(actorUserId);
      if (!actor) {
        return err({ code: 'UNAUTHORIZED', message: 'Authenticated user does not exist' });
      }
      const parsed = CreateProjectInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: formatZodIssue(parsed.error, 'Invalid project payload'),
        });
      }
      const timestamp = now().toISOString();
      const project: StoredProjectRecord = {
        id: randomUUID(),
        name: parsed.data.name,
        description: parsed.data.description,
        ownerId: actor.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await repo.createProject(project, {
        projectId: project.id,
        userId: actor.id,
        role: 'owner',
        addedAt: timestamp,
      });
      return ok(toProjectDto(project, 'owner'));
    },

    listProjects: async (actorUserId): Promise<Result<Project[]>> => {
      if (!UuidSchema.safeParse(actorUserId).success) {
        return err({ code: 'UNAUTHORIZED', message: 'Valid authenticated actor is required' });
      }
      const rows = await repo.listUserProjects(actorUserId);
      return ok(rows.map((row) => toProjectDto(row.project, row.role)));
    },

    getProject: async (actorUserId, projectId): Promise<Result<Project>> => {
      const access = await checkMembershipAccess(repo, actorUserId, projectId, 'read');
      if (!access.ok) {
        return access;
      }
      const project = await repo.findProjectById(projectId);
      if (!project) {
        return err({ code: 'NOT_FOUND', message: 'Project not found' });
      }
      return ok(toProjectDto(project, access.value.role));
    },

    updateProject: async (actorUserId, projectId, input): Promise<Result<Project>> => {
      const access = await checkMembershipAccess(repo, actorUserId, projectId, 'edit_documents');
      if (!access.ok) {
        return access;
      }
      const parsed = UpdateProjectInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: formatZodIssue(parsed.error, 'Invalid project update payload'),
        });
      }
      const updated = await repo.updateProject(projectId, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        updatedAt: now().toISOString(),
      });
      if (!updated) {
        return err({ code: 'NOT_FOUND', message: 'Project not found' });
      }
      return ok(toProjectDto(updated, access.value.role));
    },

    deleteProject: async (actorUserId, projectId): Promise<Result<{ readonly deleted: true }>> => {
      const access = await checkMembershipAccess(repo, actorUserId, projectId, 'delete_project');
      if (!access.ok) {
        return access;
      }
      const deleted = await repo.deleteProject(projectId);
      if (!deleted) {
        return err({ code: 'NOT_FOUND', message: 'Project not found' });
      }
      return ok({ deleted: true });
    },

    addMember: async (actorUserId, projectId, input): Promise<Result<ProjectMember>> => {
      const access = await checkMembershipAccess(repo, actorUserId, projectId, 'manage_members');
      if (!access.ok) {
        return access;
      }
      const parsed = AddProjectMemberInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: formatZodIssue(parsed.error, 'Invalid member invitation payload'),
        });
      }
      const targetUser = await repo.findUserByEmail(parsed.data.email);
      if (!targetUser) {
        return err({ code: 'NOT_FOUND', message: 'Target user not found' });
      }
      const existing = await repo.findMember(projectId, targetUser.id);
      if (existing) {
        return err({ code: 'CONFLICT', message: 'User is already a member of this project' });
      }
      const member: StoredMemberRecord = {
        projectId,
        userId: targetUser.id,
        role: parsed.data.role,
        addedAt: now().toISOString(),
      };
      await repo.upsertMember(member);
      return ok(toMemberDto(member, targetUser));
    },

    updateMemberRole: async (
      actorUserId,
      projectId,
      targetUserId,
      input,
    ): Promise<Result<ProjectMember>> => {
      const access = await checkMembershipAccess(repo, actorUserId, projectId, 'manage_members');
      if (!access.ok) {
        return access;
      }
      const parsed = UpdateProjectMemberRoleInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: formatZodIssue(parsed.error, 'Invalid role update payload'),
        });
      }
      const project = await repo.findProjectById(projectId);
      if (project && project.ownerId === targetUserId && parsed.data.role !== 'owner') {
        return err({ code: 'CONFLICT', message: 'Project owner role cannot be downgraded' });
      }
      const existing = await repo.findMember(projectId, targetUserId);
      const user = await repo.findUserById(targetUserId);
      if (!existing || !user) {
        return err({ code: 'NOT_FOUND', message: 'Project member not found' });
      }
      const updated: StoredMemberRecord = { ...existing, role: parsed.data.role };
      await repo.upsertMember(updated);
      return ok(toMemberDto(updated, user));
    },

    removeMember: async (
      actorUserId,
      projectId,
      targetUserId,
    ): Promise<Result<{ readonly removed: true }>> => {
      const access = await checkMembershipAccess(repo, actorUserId, projectId, 'manage_members');
      if (!access.ok) {
        return access;
      }
      const project = await repo.findProjectById(projectId);
      if (project && project.ownerId === targetUserId) {
        return err({ code: 'CONFLICT', message: 'Cannot remove the project owner' });
      }
      const removed = await repo.removeMember(projectId, targetUserId);
      if (!removed) {
        return err({ code: 'NOT_FOUND', message: 'Project member not found' });
      }
      return ok({ removed: true });
    },

    listMembers: async (actorUserId, projectId): Promise<Result<ProjectMember[]>> => {
      const access = await checkMembershipAccess(repo, actorUserId, projectId, 'read');
      if (!access.ok) {
        return access;
      }
      const members = await repo.listMembers(projectId);
      const output: ProjectMember[] = [];
      for (const member of members) {
        const user = await repo.findUserById(member.userId);
        if (user) {
          output.push(toMemberDto(member, user));
        }
      }
      return ok(output);
    },

    assertAccess: async (actorUserId, projectId, action) =>
      checkMembershipAccess(repo, actorUserId, projectId, action),
  };
}

export function createInMemoryProjectService(
  users: ReadonlyArray<ProjectUserSummary>,
  now?: () => Date,
): ProjectService {
  return createProjectService(createInMemoryProjectRepository(users), now);
}
