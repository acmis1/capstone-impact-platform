import { AdminPermission } from '../auth/authTypes';
import { canPreparePublication } from '../auth/permissions';
import { PublicationReadinessResult } from '../domain/publicationReadiness';
import { Project } from '../domain/project';
import { planPublicationArtifact, PublicationMediaSource } from './publicationArtifact';

export type PublicationPlanResult =
  | { resultCode: 'READY_TO_STAGE'; publicId: string; confirmedPreviewId: string; confirmedAt: string; recordCount: number; feedHash: string }
  | { resultCode: 'NOT_READY'; readinessCode: string; blockers: string[] }
  | { resultCode: 'PERMISSION_DENIED' }
  | { resultCode: 'PLAN_UNAVAILABLE' };

export interface PublicationPlanDependencies {
  getReadiness(): Promise<PublicationReadinessResult>;
  listProjects(): Promise<Project[]>;
  listProjectMedia?(): Promise<PublicationMediaSource[]>;
  privateBucket?: string;
  publicBucket?: string;
  getPublicUrl?(bucket: string, path: string): string;
}

/** Performs fresh, server-derived evaluation only; this service has no write dependency. */
export async function preparePublicationPlan(
  permissions: AdminPermission[],
  publicId: string,
  dependencies: PublicationPlanDependencies,
): Promise<PublicationPlanResult> {
  if (!canPreparePublication(permissions)) return { resultCode: 'PERMISSION_DENIED' };
  try {
    const readiness = await dependencies.getReadiness();
    if (!readiness.ready || readiness.resultCode !== 'READY' || !readiness.confirmedPreviewId || !readiness.confirmedAt) {
      return { resultCode: 'NOT_READY', readinessCode: readiness.resultCode, blockers: readiness.blockers };
    }
    const artifact = planPublicationArtifact({
      projects: await dependencies.listProjects(),
      targetPublicId: publicId,
      mediaAssets: dependencies.listProjectMedia ? await dependencies.listProjectMedia() : [],
      privateBucket: dependencies.privateBucket || 'project-drafts-private',
      publicBucket: dependencies.publicBucket || 'project-public-assets',
      getPublicUrl: dependencies.getPublicUrl || (() => { throw new Error('Public media URL resolver unavailable.'); }),
    });
    return { resultCode: 'READY_TO_STAGE', publicId, confirmedPreviewId: readiness.confirmedPreviewId, confirmedAt: readiness.confirmedAt, recordCount: artifact.recordCount, feedHash: artifact.feedHash };
  } catch {
    return { resultCode: 'PLAN_UNAVAILABLE' };
  }
}
