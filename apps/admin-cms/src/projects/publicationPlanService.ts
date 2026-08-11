import { AdminPermission } from '../auth/authTypes';
import { canPreparePublication } from '../auth/permissions';
import { compilePublicationCandidateFeed } from '../feed/compilePublicFeed';
import { serializePublicFeedArtifact } from '../feed/serializePublicFeedArtifact';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { PublicationReadinessResult } from '../domain/publicationReadiness';
import { Project } from '../domain/project';

export type PublicationPlanResult =
  | { resultCode: 'READY_TO_STAGE'; publicId: string; confirmedPreviewId: string; confirmedAt: string; recordCount: number; feedHash: string }
  | { resultCode: 'NOT_READY'; readinessCode: string; blockers: string[] }
  | { resultCode: 'PERMISSION_DENIED' }
  | { resultCode: 'PLAN_UNAVAILABLE' };

export interface PublicationPlanDependencies {
  getReadiness(): Promise<PublicationReadinessResult>;
  listProjects(): Promise<Project[]>;
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
    const feed = compilePublicationCandidateFeed(await dependencies.listProjects(), publicId);
    if (!validatePublicFeed(feed).valid) return { resultCode: 'PLAN_UNAVAILABLE' };
    const artifact = serializePublicFeedArtifact(feed);
    return { resultCode: 'READY_TO_STAGE', publicId, confirmedPreviewId: readiness.confirmedPreviewId, confirmedAt: readiness.confirmedAt, recordCount: artifact.recordCount, feedHash: artifact.feedHash };
  } catch {
    return { resultCode: 'PLAN_UNAVAILABLE' };
  }
}
