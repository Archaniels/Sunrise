import { z } from 'zod';

export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const;

export const ProjectRoleSchema = z.enum(PROJECT_ROLES);

export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const PROJECT_ACTIONS = [
  'read',
  'write_files',
  'edit_documents',
  'manage_members',
  'delete_project',
] as const;

export const ProjectActionSchema = z.enum(PROJECT_ACTIONS);

export type ProjectAction = z.infer<typeof ProjectActionSchema>;

const ROLE_ALLOWED_ACTIONS: Readonly<Record<ProjectRole, readonly ProjectAction[]>> = {
  owner: ['read', 'write_files', 'edit_documents', 'manage_members', 'delete_project'],
  editor: ['read', 'write_files', 'edit_documents'],
  viewer: ['read'],
};

export function canRolePerform(role: ProjectRole, action: ProjectAction): boolean {
  return ROLE_ALLOWED_ACTIONS[role].includes(action);
}

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);

export const PasswordSchema = z.string().min(12).max(128);

export const DisplayNameSchema = z.string().trim().min(1).max(100);

export const UuidSchema = z.string().uuid();

export const UserPublicSchema = z
  .object({
    id: UuidSchema,
    email: EmailSchema,
    displayName: DisplayNameSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export type UserPublic = z.infer<typeof UserPublicSchema>;

export const SignupInputSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
});

export type SignupInput = z.infer<typeof SignupInputSchema>;

export const LoginInputSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
});

export type LoginInput = z.infer<typeof LoginInputSchema>;

export const RefreshSessionInputSchema = z.object({
  refreshToken: z.string().min(16).max(2048),
});

export type RefreshSessionInput = z.infer<typeof RefreshSessionInputSchema>;

export const LogoutInputSchema = z.object({
  refreshToken: z.string().min(16).max(2048),
});

export type LogoutInput = z.infer<typeof LogoutInputSchema>;

export const AuthTokensSchema = z.object({
  accessToken: z.string().min(16).max(4096),
  refreshToken: z.string().min(16).max(4096),
  expiresAt: z.string().datetime(),
  tokenType: z.literal('Bearer'),
});

export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const AuthSessionResponseSchema = z.object({
  user: UserPublicSchema,
  tokens: AuthTokensSchema,
});

export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const KeychainSessionSchema = z.object({
  userId: UuidSchema,
  email: EmailSchema,
  accessToken: z.string().min(16).max(4096),
  refreshToken: z.string().min(16).max(4096),
  expiresAt: z.string().datetime(),
});

export type KeychainSession = z.infer<typeof KeychainSessionSchema>;

export const ProjectSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(140),
  description: z.string().max(2000),
  ownerId: UuidSchema,
  role: ProjectRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(140),
  description: z.string().max(2000).default(''),
});

export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const UpdateProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(140).optional(),
  description: z.string().max(2000).optional(),
});

export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const ProjectMemberSchema = z.object({
  projectId: UuidSchema,
  userId: UuidSchema,
  email: EmailSchema,
  displayName: DisplayNameSchema,
  role: ProjectRoleSchema,
  addedAt: z.string().datetime(),
});

export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const AddProjectMemberInputSchema = z.object({
  email: EmailSchema,
  role: z.enum(['editor', 'viewer']),
});

export type AddProjectMemberInput = z.infer<typeof AddProjectMemberInputSchema>;

export const UpdateProjectMemberRoleInputSchema = z.object({
  role: ProjectRoleSchema,
});

export type UpdateProjectMemberRoleInput = z.infer<typeof UpdateProjectMemberRoleInputSchema>;
