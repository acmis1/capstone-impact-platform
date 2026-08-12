import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';
import { SupabasePublicRemovalRepositoryCore } from '../repositories/SupabasePublicRemovalRepositoryCore';
import { ControlledPublicRemovalDependencies } from './controlledPublicRemovalService';

export function createControlledPublicRemovalDependencies(params: { supabase: SupabaseClient; supabaseUrl: string; publicId: string; adminId: string; feedBucket: string; feedPath: string }): ControlledPublicRemovalDependencies {
  const removal = new SupabasePublicRemovalRepositoryCore(params.supabase, params.supabaseUrl);
  const projects = new SupabaseProjectRepositoryCore(params.supabase);
  const publicUrl = removal.getPublicUrl(params.feedBucket, params.feedPath);
  return {
    assertDisposableLocalEnvironment: () => removal.assertDisposableLocalEnvironment(),
    listProjects: () => projects.listProjects(),
    getCompletedAttempt: () => removal.getCompletedAttempt(params.publicId),
    getRecoverableAttempt: () => removal.getRecoverableAttempt(params.publicId),
    getArchiveAuditRecord: (id) => removal.getArchiveAuditRecord(id),
    reserveAttempt: (reason) => removal.reserveAttempt(params.publicId, params.adminId, reason),
    prepareAttempt: (id, token, artifact, previous) => removal.prepareAttempt({ attemptId: id, token, count: artifact.recordCount, hash: artifact.feedHash, content: artifact.content, bucket: params.feedBucket, path: params.feedPath, publicUrl, previous }),
    claimAttempt: () => removal.claimAttempt(params.publicId, params.adminId),
    markStorageWritten: (id, token, hash, count) => removal.markStorageWritten(id, token, hash, count),
    finalizeAttempt: (id, token) => removal.finalizeAttempt(id, token),
    failAttempt: (id, token, failure, compensation) => removal.failAttempt(id, token, failure, compensation),
    downloadFeed: () => removal.downloadObject(params.feedBucket, params.feedPath),
    overwriteFeed: (content) => removal.overwriteObject(params.feedBucket, params.feedPath, content),
  };
}
