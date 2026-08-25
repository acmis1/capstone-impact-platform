import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminPermission } from '../auth/authTypes';
import { canPreparePublication } from '../auth/permissions';
import type {
  PublicationReadinessResult,
  ReconciliationReadinessResult,
} from '../domain/publicationReadiness';
import type { Project } from '../domain/project';
import { composePublicFeedPublication } from '../feed/publicFeedArtifact';
import { validateMediaAssetBytes } from '../storage/mediaValidationCore';
import { promoteBoundPublicMedia, validateBoundPublicMedia } from './boundPublicMediaPromotion';
import {
  planPublicationArtifact,
  type PublicationMediaBinding,
  type PublicationMediaSource,
} from './publicationArtifact';
import { findPublicationCompletionEvidence } from './publicFeedTargetEvidence';
import { executePublicFeedWriter, inspectPublicFeedHead } from './publicFeedWriterCoordinator';

export type ControlledPublicationResult =
  | {
      resultCode: 'COMPLETED' | 'ALREADY_COMPLETED'; attemptId: string;
      /**
       * Target-specific completion evidence. `auditRecordId` is null for deployment
       * reconciliation, which changes no project lifecycle state and therefore writes no approval
       * record. Neither identifier is ever borrowed from an unrelated operation.
       */
      snapshotId: string | null; auditRecordId: string | null; recordCount: number;
      feedHash: string; feedPublicUrl: string;
    }
  | { resultCode: 'PERMISSION_DENIED' | 'PUBLICATION_IN_PROGRESS' | 'RECOVERY_REQUIRED' }
  | { resultCode: 'NOT_READY'; readinessCode: string; blockers: string[] }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

export interface ControlledPublicationDependencies {
  supabase: SupabaseClient;
  adminId: string;
  assertExecutionEnvironment(): void;
  getReadiness(): Promise<PublicationReadinessResult>;
  /**
   * Deployment-reconciliation readiness. A SEPARATE authority from getReadiness, which is a
   * pre-publication gate demanding an approved target. Reconciliation targets are already
   * lifecycle `published`, so this proves the current published content is still backed by the
   * exact participant confirmation instead of weakening the normal gate.
   */
  getReconciliationReadiness(): Promise<ReconciliationReadinessResult>;
  listProjects(): Promise<Project[]>;
  listProjectMedia(): Promise<PublicationMediaSource[]>;
  getPublicUrl(bucket: string, path: string): string;
  downloadObject(bucket: string, path: string): Promise<Buffer | null>;
  uploadNewObject(bucket: string, path: string, content: Buffer, contentType: string): Promise<boolean>;
}

export type ControlledPublicationFailurePoint =
  | 'after_reservation' | 'before_artifact_bind' | 'before_media_upload'
  | 'during_media_upload' | 'simulated_process_crash_after_media_write'
  | 'before_feed_upload' | 'after_feed_verification' | 'before_finalize';
export interface ControlledPublicationBarriers { afterReservation?(): Promise<void> }

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function captureMediaBindings(
  dependencies: ControlledPublicationDependencies,
  promotions: ReturnType<typeof planPublicationArtifact>['mediaPromotions'],
): Promise<PublicationMediaBinding[]> {
  const bindings: PublicationMediaBinding[] = [];
  for (const media of promotions) {
    const source = await dependencies.downloadObject(media.sourceBucket, media.sourcePath);
    if (!source) throw new Error('PRIVATE_MEDIA_UNAVAILABLE');
    const valid = validateMediaAssetBytes({
      fileName: media.fileName, content: source, expectedMimeType: media.mimeType,
      expectedFileSizeBytes: media.fileSizeBytes,
    });
    if (!valid.valid) throw new Error('PRIVATE_MEDIA_INVALID');
    const existing = await dependencies.downloadObject(media.publicBucket, media.publicPath);
    if (existing && !existing.equals(source)) throw new Error('MEDIA_STORAGE_CONFLICT');
    bindings.push({ ...media, preExisting: existing !== null, sourceSha256: sha256(source) });
  }
  return bindings;
}

export async function executeControlledPublication(params: {
  permissions: AdminPermission[];
  publicId: string;
  privateBucket: string;
  publicAssetsBucket: string;
  publicFeedBucket: string;
  publicFeedPath: string;
  dependencies: ControlledPublicationDependencies;
  publicationMode?: 'normal' | 'deployment_reconciliation';
  failurePoint?: ControlledPublicationFailurePoint;
  barriers?: ControlledPublicationBarriers;
}): Promise<ControlledPublicationResult> {
  const { permissions, publicId, privateBucket, publicAssetsBucket, publicFeedBucket,
    publicFeedPath, dependencies } = params;
  const mode = params.publicationMode ?? 'normal';
  if (!canPreparePublication(permissions)) return { resultCode: 'PERMISSION_DENIED' };
  try { dependencies.assertExecutionEnvironment(); }
  catch { return { resultCode: 'EXECUTION_FAILED', failureCode: 'EXECUTION_POLICY_DENIED' }; }

  try {
    const projects = await dependencies.listProjects();
    const targets = projects.filter((project) => project.publicId === publicId);
    if (targets.length !== 1) {
      return { resultCode: 'NOT_READY', readinessCode: 'PROJECT_NOT_FOUND', blockers: ['Project not found'] };
    }
    const target = targets[0];
    if (target.status === 'published') {
      const inspected = await inspectPublicFeedHead(dependencies.supabase, publicFeedBucket, publicFeedPath);
      if (inspected.head && inspected.artifact?.members.some((member) => member.publicId === publicId)) {
        // Membership in the current head answers only "is this target deployed". The operation,
        // snapshot and audit identifiers that belong to this target come from its own immutable
        // history, never from whichever operation happens to own the head right now.
        const evidence = await findPublicationCompletionEvidence(
          dependencies.supabase, publicId, inspected.head,
        );
        if (!evidence) {
          return {
            resultCode: 'NOT_READY', readinessCode: 'ALREADY_DEPLOYED_UNVERIFIED',
            blockers: ['The project is already deployed in the current public feed, but no publication operation in its own history explains the deployed record.'],
          };
        }
        return {
          resultCode: 'ALREADY_COMPLETED', attemptId: evidence.operationId,
          snapshotId: evidence.publishedSnapshotId, auditRecordId: evidence.auditRecordId,
          recordCount: inspected.artifact.recordCount, feedHash: inspected.artifact.feedHash,
          feedPublicUrl: inspected.publicUrl,
        };
      }
    }

    // Lifecycle 'published' alone is never deployment authority. Reconciliation proves, from
    // authoritative persisted state, that the CURRENT published content is still backed by the
    // exact participant confirmation it was published under. The database repeats every one of
    // these checks at the final pre-side-effect boundary; this preflight only avoids reserving
    // work that cannot succeed.
    const readiness = mode === 'deployment_reconciliation'
      ? await dependencies.getReconciliationReadiness()
      : await dependencies.getReadiness();
    if (!readiness.ready || readiness.resultCode !== 'READY'
        || !readiness.confirmedPreviewId || !readiness.confirmedAt) {
      return { resultCode: 'NOT_READY', readinessCode: readiness.resultCode, blockers: readiness.blockers };
    }

    const writer = await executePublicFeedWriter({
      supabase: dependencies.supabase, adminId: dependencies.adminId, kind: 'publication',
      publicationMode: mode, publicId,
      confirmedPreviewId: readiness.confirmedPreviewId,
      confirmedAt: readiness.confirmedAt, privateBucket,
      feedBucket: publicFeedBucket, feedPath: publicFeedPath,
      prepareCandidate: async (baseline) => {
        if (!baseline) throw new Error('HISTORY_NOT_ACTIVE');
        if (baseline.members.some((member) => member.publicId === publicId)) {
          throw new Error('PUBLIC_ID_ALREADY_DEPLOYED');
        }
        const media = await dependencies.listProjectMedia();
        const plan = planPublicationArtifact({
          projects: [target], targetPublicId: publicId, mediaAssets: media,
          privateBucket, publicBucket: publicAssetsBucket,
          getPublicUrl: dependencies.getPublicUrl, mode,
        });
        const manifest = await captureMediaBindings(dependencies, plan.mediaPromotions);
        return { artifact: composePublicFeedPublication(baseline, plan.feed[0]), mediaManifest: manifest };
      },
      validateBeforeWriteIntent: (manifest) => validateBoundPublicMedia(dependencies, manifest),
      afterWriteIntent: (manifest) => promoteBoundPublicMedia(dependencies, manifest),
    });

    if (writer.resultCode === 'COMPLETED' || writer.resultCode === 'ALREADY_COMPLETED') {
      return {
        resultCode: writer.resultCode, attemptId: writer.operationId,
        snapshotId: writer.snapshotId, auditRecordId: writer.auditRecordId,
        recordCount: writer.recordCount, feedHash: writer.feedHash,
        feedPublicUrl: writer.feedPublicUrl,
      };
    }
    if (writer.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
    if (writer.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
    if (writer.resultCode === 'RECOVERY_REQUIRED') return { resultCode: 'RECOVERY_REQUIRED' };
    if (writer.resultCode === 'NOT_READY' || writer.resultCode === 'HISTORY_NOT_ACTIVE'
        || writer.resultCode === 'ALREADY_DEPLOYED') {
      return { resultCode: 'NOT_READY', readinessCode: writer.resultCode, blockers: ['Public deployment state changed'] };
    }
    return writer.resultCode === 'EXECUTION_FAILED'
      ? writer
      : { resultCode: 'EXECUTION_FAILED', failureCode: writer.resultCode };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : 'EXECUTION_UNAVAILABLE';
    return { resultCode: 'EXECUTION_FAILED', failureCode: code };
  }
}
