import type { SupabaseClient } from '@supabase/supabase-js';

export interface PublicFeedHistoryListItem {
  versionNumber: number;
  operation: 'baseline' | 'publication' | 'removal' | 'rollback';
  publicationMode: string | null;
  createdAt: string;
  actorDisplay: string;
  completionActorDisplay: string | null;
  recordCount: number;
  byteCount: number;
  feedHash: string;
  current: boolean;
  affectedPublicId: string | null;
  affectedTitle: string | null;
  previousVersionNumber: number | null;
  restoredFromVersionNumber: number | null;
}

export interface PublicFeedHistoryDetail extends PublicFeedHistoryListItem {
  members: Array<{
    ordinal: number;
    publicId: string;
    title: string | null;
    lifecycleStatus: string;
    currentlyDeployed: boolean;
  }>;
}

export interface PublicFeedDeploymentStatus {
  publicId: string;
  title: string;
  lifecycleStatus: string;
  deployed: boolean;
}

export interface PublicFeedHistoryView {
  active: boolean;
  rollbackEnabled: boolean;
  currentVersionNumber: number | null;
  generation: number | null;
  versions: PublicFeedHistoryListItem[];
  detail: PublicFeedHistoryDetail | null;
  deploymentStatuses: PublicFeedDeploymentStatus[];
  blockingOperation: { kind: string; state: string; failureCode: string | null; updatedAt: string } | null;
}

function actorDisplay(actor: { full_name?: unknown; email?: unknown } | undefined): string {
  const name = typeof actor?.full_name === 'string' ? actor.full_name.trim() : '';
  const email = typeof actor?.email === 'string' ? actor.email.trim() : '';
  return name || email || 'Former administrator';
}

export async function readPublicFeedHistory(
  supabase: SupabaseClient,
  selectedVersionNumber?: number,
): Promise<PublicFeedHistoryView> {
  const [headResult, versionsResult, projectsResult, blockingResult] = await Promise.all([
    supabase.from('public_feed_head').select('current_version_id,generation,rollback_enabled').eq('singleton', true).maybeSingle(),
    supabase.from('public_feed_versions').select(
      'id,version_number,operation,publication_mode,previous_version_id,restored_from_version_id,affected_public_id,authorizing_actor_id,completion_actor_id,byte_count,feed_hash,record_count,created_at',
    ).order('version_number', { ascending: false }).limit(100),
    supabase.from('projects').select('public_id,title,status,deleted_at').is('deleted_at', null),
    supabase.from('public_feed_operations').select('kind,state,failure_code,updated_at')
      .in('state', ['RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED'])
      .limit(1).maybeSingle(),
  ]);
  if (headResult.error || versionsResult.error || projectsResult.error || blockingResult.error) {
    throw new Error('PUBLIC_FEED_HISTORY_READ_FAILED');
  }

  const rows = versionsResult.data ?? [];
  const actorIds = [...new Set(rows.flatMap((row) => [row.authorizing_actor_id, row.completion_actor_id]).filter(Boolean).map(String))];
  const actorResult = actorIds.length === 0
    ? { data: [], error: null }
    : await supabase.from('admin_users').select('id,full_name,email').in('id', actorIds);
  if (actorResult.error) throw new Error('PUBLIC_FEED_HISTORY_ACTOR_READ_FAILED');
  const actors = new Map((actorResult.data ?? []).map((row) => [String(row.id), row]));
  const projects = new Map((projectsResult.data ?? []).map((row) => [String(row.public_id), row]));
  const versionNumberById = new Map(rows.map((row) => [String(row.id), Number(row.version_number)]));
  const currentVersionId = headResult.data?.current_version_id ? String(headResult.data.current_version_id) : null;

  const versions: PublicFeedHistoryListItem[] = rows.map((row) => {
    const publicId = row.affected_public_id === null ? null : String(row.affected_public_id);
    return {
      versionNumber: Number(row.version_number),
      operation: row.operation as PublicFeedHistoryListItem['operation'],
      publicationMode: row.publication_mode === null ? null : String(row.publication_mode),
      createdAt: String(row.created_at), actorDisplay: actorDisplay(actors.get(String(row.authorizing_actor_id))),
      completionActorDisplay: row.completion_actor_id === null ? null : actorDisplay(actors.get(String(row.completion_actor_id))),
      recordCount: Number(row.record_count), byteCount: Number(row.byte_count), feedHash: String(row.feed_hash),
      current: String(row.id) === currentVersionId, affectedPublicId: publicId,
      affectedTitle: publicId ? String(projects.get(publicId)?.title ?? '') || null : null,
      previousVersionNumber: row.previous_version_id === null ? null : versionNumberById.get(String(row.previous_version_id)) ?? null,
      restoredFromVersionNumber: row.restored_from_version_id === null ? null : versionNumberById.get(String(row.restored_from_version_id)) ?? null,
    };
  });

  const selected = selectedVersionNumber
    ? rows.find((row) => Number(row.version_number) === selectedVersionNumber)
    : rows.find((row) => String(row.id) === currentVersionId) ?? rows[0];
  let detail: PublicFeedHistoryDetail | null = null;
  if (selected) {
    const memberResult = await supabase.from('public_feed_version_members')
      .select('ordinal,public_id').eq('version_id', selected.id).order('ordinal', { ascending: true });
    if (memberResult.error) throw new Error('PUBLIC_FEED_HISTORY_MEMBER_READ_FAILED');
    const item = versions.find((candidate) => candidate.versionNumber === Number(selected.version_number));
    if (item) {
      detail = {
        ...item,
        members: (memberResult.data ?? []).map((member) => {
          const project = projects.get(String(member.public_id));
          return {
            ordinal: Number(member.ordinal), publicId: String(member.public_id),
            title: project ? String(project.title) : null,
            lifecycleStatus: project ? String(project.status) : 'missing',
            currentlyDeployed: String(selected.id) === currentVersionId,
          };
        }),
      };
    }
  }

  const currentMembersResult = currentVersionId
    ? await supabase.from('public_feed_version_members').select('public_id').eq('version_id', currentVersionId)
    : { data: [], error: null };
  if (currentMembersResult.error) throw new Error('PUBLIC_FEED_HEAD_MEMBER_READ_FAILED');
  const deployed = new Set((currentMembersResult.data ?? []).map((row) => String(row.public_id)));
  if (detail) {
    detail = {
      ...detail,
      members: detail.members.map((member) => ({
        ...member,
        currentlyDeployed: deployed.has(member.publicId),
      })),
    };
  }
  const deploymentStatuses = (projectsResult.data ?? [])
    .filter((row) => ['published', 'archived'].includes(String(row.status)) || deployed.has(String(row.public_id)))
    .map((row) => ({
      publicId: String(row.public_id), title: String(row.title), lifecycleStatus: String(row.status),
      deployed: deployed.has(String(row.public_id)),
    }))
    .sort((a, b) => a.publicId.localeCompare(b.publicId));

  return {
    active: Boolean(headResult.data), rollbackEnabled: headResult.data?.rollback_enabled === true,
    currentVersionNumber: versions.find((item) => item.current)?.versionNumber ?? null,
    generation: headResult.data ? Number(headResult.data.generation) : null,
    versions, detail, deploymentStatuses,
    blockingOperation: blockingResult.data ? {
      kind: String(blockingResult.data.kind), state: String(blockingResult.data.state),
      failureCode: blockingResult.data.failure_code === null ? null : String(blockingResult.data.failure_code),
      updatedAt: String(blockingResult.data.updated_at),
    } : null,
  };
}
