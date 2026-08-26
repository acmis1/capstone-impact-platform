import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminPermission } from '../auth/authTypes';
import { hasPermission } from '../auth/permissions';
import type { Project } from '../domain/project';
import { composePublicFeedRemoval } from '../feed/publicFeedArtifact';
import { findRemovalCompletionEvidence } from './publicFeedTargetEvidence';
import { executePublicFeedWriter, inspectPublicFeedHead } from './publicFeedWriterCoordinator';

export interface PublicRemovalArtifact {
  content: string;
  feedHash: string;
  recordCount: number;
}

export type ControlledPublicRemovalResult =
  /**
   * `auditRecordId` is null when the removal changed no lifecycle state — a target that was
   * already archived and already absent writes no approval record. It is never populated from an
   * unrelated operation to avoid a null.
   */
  | ({ resultCode: 'COMPLETED' | 'ALREADY_COMPLETED'; attemptId: string; auditRecordId: string | null } & PublicRemovalArtifact)
  | { resultCode: 'PERMISSION_DENIED' | 'PUBLICATION_IN_PROGRESS' | 'RECOVERY_REQUIRED' | 'NOT_PUBLISHED' }
  | { resultCode: 'EXECUTION_FAILED'; failureCode: string };

export interface ControlledPublicRemovalDependencies {
  supabase: SupabaseClient;
  adminId: string;
  feedBucket: string;
  feedPath: string;
  assertExecutionEnvironment(): void;
  listProjects(): Promise<Project[]>;
}

export type PublicRemovalFailurePoint = 'after_reservation' | 'after_feed_write' | 'before_finalize';
export interface PublicRemovalBarriers { afterReservation?(): Promise<void> }

export async function executeControlledPublicRemoval(params: {
  permissions: AdminPermission[];
  publicId: string;
  archiveReason: string;
  dependencies: ControlledPublicRemovalDependencies;
  failurePoint?: PublicRemovalFailurePoint;
  barriers?: PublicRemovalBarriers;
}): Promise<ControlledPublicRemovalResult> {
  const { permissions, publicId, archiveReason, dependencies } = params;
  if (!hasPermission(permissions, 'projects.archive')) return { resultCode: 'PERMISSION_DENIED' };
  try { dependencies.assertExecutionEnvironment(); }
  catch { return { resultCode: 'EXECUTION_FAILED', failureCode: 'NON_LOCAL_ENVIRONMENT' }; }

  try {
    const projects = await dependencies.listProjects();
    const targets = projects.filter((project) => project.publicId === publicId);
    if (targets.length !== 1 || !['published', 'archived'].includes(targets[0].status)) {
      return { resultCode: 'NOT_PUBLISHED' };
    }
    const target = targets[0];
    if (target.status === 'archived') {
      const inspected = await inspectPublicFeedHead(
        dependencies.supabase, dependencies.feedBucket, dependencies.feedPath,
      );
      if (inspected.head && inspected.artifact
          && !inspected.artifact.members.some((member) => member.publicId === publicId)) {
        // Absence from the current head only says the target is not deployed. Completion evidence
        // must come from this target's own removal history; when none explains the current absence
        // — a rollback, typically — no identifiers are invented and a genuine target-specific
        // removal operation is executed below instead.
        const evidence = await findRemovalCompletionEvidence(
          dependencies.supabase, publicId, inspected.head,
        );
        if (evidence) {
          return {
            resultCode: 'ALREADY_COMPLETED', attemptId: evidence.operationId,
            auditRecordId: evidence.auditRecordId,
            content: inspected.artifact.content, feedHash: inspected.artifact.feedHash,
            recordCount: inspected.artifact.recordCount,
          };
        }
      }
    }

    const writer = await executePublicFeedWriter({
      supabase: dependencies.supabase, adminId: dependencies.adminId,
      kind: 'removal', publicId, archiveReason,
      feedBucket: dependencies.feedBucket, feedPath: dependencies.feedPath,
      prepareCandidate: async (baseline) => {
        if (!baseline) throw new Error('HISTORY_NOT_ACTIVE');
        if (target.status === 'published'
            && baseline.members.filter((member) => member.publicId === publicId).length !== 1) {
          throw new Error('CURRENT_FEED_DIVERGED');
        }
        return { artifact: composePublicFeedRemoval(baseline, publicId) };
      },
    });
    if (writer.resultCode === 'COMPLETED' || writer.resultCode === 'ALREADY_COMPLETED') {
      return {
        resultCode: writer.resultCode, attemptId: writer.operationId,
        auditRecordId: writer.auditRecordId, content: '',
        feedHash: writer.feedHash, recordCount: writer.recordCount,
      };
    }
    if (writer.resultCode === 'PERMISSION_DENIED') return { resultCode: 'PERMISSION_DENIED' };
    if (writer.resultCode === 'PUBLICATION_IN_PROGRESS') return { resultCode: 'PUBLICATION_IN_PROGRESS' };
    if (writer.resultCode === 'NOT_PUBLISHED') return { resultCode: 'NOT_PUBLISHED' };
    if (writer.resultCode === 'RECOVERY_REQUIRED') return { resultCode: 'RECOVERY_REQUIRED' };
    return writer.resultCode === 'EXECUTION_FAILED'
      ? writer
      : { resultCode: 'EXECUTION_FAILED', failureCode: writer.resultCode };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : 'EXECUTION_UNAVAILABLE';
    return { resultCode: 'EXECUTION_FAILED', failureCode: code };
  }
}
