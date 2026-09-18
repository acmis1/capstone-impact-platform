import { z } from 'zod';
import type { AdminPermission, AdminRole } from '../auth/authTypes';
import { resolvedLayoutConfigSchema, type ResolvedLayoutConfig } from '../domain/layoutConfig';

export const layoutMaintenanceInputSchema = z.object({
  publicId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  layoutConfig: resolvedLayoutConfigSchema,
  recipeVersionId: z.string().uuid().nullable().optional(),
}).strict();

export type ProjectLayoutMaintenanceResult =
  | { resultCode: 'UPDATED'; publicId: string; status: 'draft' | 'changes_requested'; updatedAt: string; auditRecordId: string; revokedActivePreviewCount: number }
  | { resultCode: 'UNCHANGED'; publicId: string; status: 'draft' | 'changes_requested' }
  | { resultCode: string; publicId?: string; status?: string; reason?: string };

export interface ProjectLayoutMaintenanceGateway {
  update(input: {
    publicId: string;
    expectedUpdatedAt: string;
    layoutConfig: ResolvedLayoutConfig;
    recipeVersionId: string | null;
    adminId: string;
  }): Promise<ProjectLayoutMaintenanceResult>;
}

export interface ProjectLayoutMaintenanceActor {
  adminId: string;
  permissions: AdminPermission[];
  roles: AdminRole[];
}

export class ProjectLayoutMaintenancePermissionError extends Error {
  constructor() {
    super('Project layout maintenance permission denied.');
    this.name = 'ProjectLayoutMaintenancePermissionError';
  }
}

export function canChangeProjectLayout(actor: ProjectLayoutMaintenanceActor): boolean {
  return actor.roles.includes('admin') && actor.permissions.includes('projects.edit');
}

export async function updateProjectLayout(params: {
  actor: ProjectLayoutMaintenanceActor;
  gateway: ProjectLayoutMaintenanceGateway;
  input: unknown;
}): Promise<ProjectLayoutMaintenanceResult> {
  if (!canChangeProjectLayout(params.actor)) throw new ProjectLayoutMaintenancePermissionError();
  const parsed = layoutMaintenanceInputSchema.safeParse(params.input);
  if (!parsed.success) return { resultCode: 'VALIDATION_FAILED' };
  return params.gateway.update({
    ...parsed.data,
    recipeVersionId: parsed.data.recipeVersionId ?? null,
    adminId: params.actor.adminId,
  });
}
