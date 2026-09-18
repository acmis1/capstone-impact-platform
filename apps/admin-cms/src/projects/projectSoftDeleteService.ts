import { hasPermission } from '../auth/permissions';
import type { AdminPermission } from '../auth/authTypes';
import type {
  SoftDeleteExecutionResult,
  SoftDeletePreflightItem,
  SoftDeletePreflightResponse,
} from './projectSoftDelete';
import { SOFT_DELETE_MAX_SELECTION, summarizeSoftDeletePreflight } from './projectSoftDelete';

export interface ProjectSoftDeleteActor {
  adminId: string;
  permissions: AdminPermission[];
}

export interface ProjectSoftDeleteGateway {
  preflight(publicIds: string[], adminId: string): Promise<SoftDeletePreflightItem[]>;
  execute(params: {
    publicId: string;
    expectedUpdatedAt: string;
    adminId: string;
  }): Promise<SoftDeleteExecutionResult>;
}

export class ProjectSoftDeletePermissionError extends Error {
  constructor() {
    super('Project soft delete permission denied.');
    this.name = 'ProjectSoftDeletePermissionError';
  }
}

export class ProjectSoftDeleteService {
  constructor(private readonly gateway: ProjectSoftDeleteGateway) {}

  private authorize(actor: ProjectSoftDeleteActor): void {
    if (!hasPermission(actor.permissions, 'projects.delete')) {
      throw new ProjectSoftDeletePermissionError();
    }
  }

  async preflight(params: {
    publicIds: string[];
    actor: ProjectSoftDeleteActor;
  }): Promise<SoftDeletePreflightResponse> {
    this.authorize(params.actor);
    if (params.publicIds.length < 1 || params.publicIds.length > SOFT_DELETE_MAX_SELECTION) {
      throw new Error('Project soft delete selection is out of bounds.');
    }
    const items = await this.gateway.preflight(params.publicIds, params.actor.adminId);
    if (
      items.length !== params.publicIds.length
      || items.some((item, index) => item.publicId !== params.publicIds[index])
    ) {
      throw new Error('Project soft delete preflight response is incomplete.');
    }
    return { summary: summarizeSoftDeletePreflight(items), items };
  }

  async execute(params: {
    publicId: string;
    expectedUpdatedAt: string;
    actor: ProjectSoftDeleteActor;
  }): Promise<SoftDeleteExecutionResult> {
    this.authorize(params.actor);
    return this.gateway.execute({
      publicId: params.publicId,
      expectedUpdatedAt: params.expectedUpdatedAt,
      adminId: params.actor.adminId,
    });
  }
}
