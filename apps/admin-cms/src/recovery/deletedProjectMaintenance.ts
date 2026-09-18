import { z } from 'zod';
import type { AdminPermission, AdminRole } from '../auth/authTypes';

export const DELETED_PROJECT_PAGE_SIZES = [20, 50] as const;
export type DeletedProjectPageSize = typeof DELETED_PROJECT_PAGE_SIZES[number];

export const deletedProjectPageQuerySchema = z.object({
  page: z.number().int().min(1).max(100_000),
  pageSize: z.union([z.literal(20), z.literal(50)]),
  search: z.string().trim().max(100).optional(),
}).strict();

export const recoverDeletedProjectInputSchema = z.object({
  publicId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  expectedDeletedAt: z.string().datetime({ offset: true }),
}).strict();

export type DeletedProjectRecovery = {
  code: string;
  reason: string;
  softDeleteAuditId?: string;
};

export type DeletedProjectRow = {
  publicId: string;
  title: string;
  status: string;
  deletedAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  recovery: DeletedProjectRecovery;
};

export type DeletedProjectList = {
  items: DeletedProjectRow[];
  total: number;
  page: number;
  pageSize: DeletedProjectPageSize;
  pageCount: number;
};

export type DeletedProjectDetail = {
  resultCode: 'FOUND';
  project: {
    id: string;
    publicId: string;
    title: string;
    status: string;
    deletedAt: string | null;
    updatedAt: string | null;
    createdAt: string | null;
    summary: string | null;
    background: string | null;
    solution: string | null;
    year: number | null;
    program: string | null;
    discipline: string | null;
    industry: string | null;
    groupName: string | null;
  };
  recovery: DeletedProjectRecovery;
  media: Array<Record<string, unknown>>;
  approvalHistory: Array<Record<string, unknown>>;
  participantPreviews: Array<Record<string, unknown>>;
  feedHistory: Array<Record<string, unknown>>;
};

export interface DeletedProjectMaintenanceGateway {
  list(input: { adminId: string; page: number; pageSize: DeletedProjectPageSize; search?: string }): Promise<DeletedProjectList>;
  detail(publicId: string, adminId: string): Promise<DeletedProjectDetail | null>;
  recover(input: { publicId: string; expectedUpdatedAt: string; expectedDeletedAt: string; adminId: string }): Promise<Record<string, unknown>>;
}

export interface DeletedProjectMaintenanceActor {
  adminId: string;
  permissions: AdminPermission[];
  roles: AdminRole[];
}

export function canManageDeletedProjects(actor: DeletedProjectMaintenanceActor): boolean {
  return actor.roles.includes('admin') && actor.permissions.includes('projects.delete');
}

export class DeletedProjectMaintenancePermissionError extends Error {
  constructor() {
    super('Deleted project maintenance permission denied.');
    this.name = 'DeletedProjectMaintenancePermissionError';
  }
}
