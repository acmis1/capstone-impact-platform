import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminPermission } from '../auth/authTypes';
import { canPreparePublication } from '../auth/permissions';
import type { PublicationReadinessResult } from '../domain/publicationReadiness';
import type { Project } from '../domain/project';
import { toPublicFeedRecord } from '../feed/compilePublicFeed';
import { composePublicFeedPublication, createPublicFeedArtifact } from '../feed/publicFeedArtifact';
import { validateMediaAssetBytes } from '../storage/mediaValidationCore';
import {
  planPublicationArtifact,
  type PublicationMediaBinding,
  type PublicationMediaSource,
} from './publicationArtifact';
import { executePublicFeedWriter, inspectPublicFeedHead } from './publicFeedWriterCoordinator';

export type ControlledPublicationResult =
  | {
      resultCode: 'COMPLETED' | 'ALREADY_COMPLETED'; attemptId: string;
      snapshotId: string; auditRecordId: string; recordCount: number;
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
  listProjects(): Promise<Project[]>;
  listProjectMedia(): Promise<PublicationMediaSource[]>;
  getPublicUrl(bucket: string, path: string): string;
  downloadObject(bucket: string, path: string): Promise<Buffer | null>;
  uploadNewObject(bucket: string, path: string, content: Buffer, contentType: string): Promise<boolean>;
  removeObjects(bucket: string, paths: string[]): Promise<void>;
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

async function promoteBoundMedia(
  dependencies: ControlledPublicationDependencies,
  manifest: PublicationMediaBinding[],
): Promise<void> {
  const created = new Map<string, string[]>();
  try {
    for (const media of manifest) {
      const source = await dependencies.downloadObject(media.sourceBucket, media.sourcePath);
      if (!source || sha256(source) !== media.sourceSha256) throw new Error('PRIVATE_MEDIA_CHANGED');
      const valid = validateMediaAssetBytes({
        fileName: media.fileName, content: source, expectedMimeType: media.mimeType,
        expectedFileSizeBytes: media.fileSizeBytes,
      });
      if (!valid.valid) throw new Error('PRIVATE_MEDIA_INVALID');
      const wasCreated = await dependencies.uploadNewObject(
        media.publicBucket, media.publicPath, source, media.mimeType,
      );
      if (wasCreated && !media.preExisting) {
        created.set(media.publicBucket, [...(created.get(media.publicBucket) ?? []), media.publicPath]);
      }
      const verified = await dependencies.downloadObject(media.publicBucket, media.publicPath);
      if (!verified || !verified.equals(source)) throw new Error('PUBLIC_MEDIA_VERIFICATION_FAILED');
    }
  } catch (error) {
    for (const [bucket, paths] of created) await dependencies.removeObjects(bucket, paths);
    throw error;
  }
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
        return {
          resultCode: 'ALREADY_COMPLETED', attemptId: inspected.head.currentVersion.operationId,
          snapshotId: inspected.head.currentVersion.publishedSnapshotId ?? '',
          auditRecordId: inspected.head.currentVersion.auditRecordId ?? '',
          recordCount: inspected.artifact.recordCount, feedHash: inspected.artifact.feedHash,
          feedPublicUrl: inspected.publicUrl,
        };
      }
    }

    let readiness: PublicationReadinessResult | null = null;
    if (mode === 'normal') {
      readiness = await dependencies.getReadiness();
      if (!readiness.ready || readiness.resultCode !== 'READY'
          || !readiness.confirmedPreviewId || !readiness.confirmedAt) {
        return { resultCode: 'NOT_READY', readinessCode: readiness.resultCode, blockers: readiness.blockers };
      }
    } else if (target.status !== 'published') {
      return { resultCode: 'NOT_READY', readinessCode: 'INVALID_PROJECT_STATE', blockers: ['Project is not lifecycle published'] };
    }

    const writer = await executePublicFeedWriter({
      supabase: dependencies.supabase, adminId: dependencies.adminId, kind: 'publication',
      publicationMode: mode, publicId,
      confirmedPreviewId: readiness?.confirmedPreviewId ?? null,
      confirmedAt: readiness?.confirmedAt ?? null, privateBucket,
      feedBucket: publicFeedBucket, feedPath: publicFeedPath,
      prepareCandidate: async (baseline) => {
        if (!baseline) throw new Error('HISTORY_NOT_ACTIVE');
        if (baseline.members.some((member) => member.publicId === publicId)) {
          throw new Error('PUBLIC_ID_ALREADY_DEPLOYED');
        }
        if (mode === 'deployment_reconciliation') {
          const record = toPublicFeedRecord(target);
          const single = createPublicFeedArtifact([record]);
          return { artifact: composePublicFeedPublication(baseline, single.feed[0]), mediaManifest: [] };
        }
        const media = await dependencies.listProjectMedia();
        const plan = planPublicationArtifact({
          projects: [target], targetPublicId: publicId, mediaAssets: media,
          privateBucket, publicBucket: publicAssetsBucket,
          getPublicUrl: dependencies.getPublicUrl,
        });
        const manifest = await captureMediaBindings(dependencies, plan.mediaPromotions);
        return { artifact: composePublicFeedPublication(baseline, plan.feed[0]), mediaManifest: manifest };
      },
      beforeCanonicalWrite: (manifest) => promoteBoundMedia(dependencies, manifest),
    });

    if (writer.resultCode === 'COMPLETED' || writer.resultCode === 'ALREADY_COMPLETED') {
      return {
        resultCode: writer.resultCode, attemptId: writer.operationId,
        snapshotId: writer.snapshotId ?? '', auditRecordId: writer.auditRecordId ?? '',
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
