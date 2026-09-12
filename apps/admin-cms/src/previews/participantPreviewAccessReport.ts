import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PreviewAccessReportCursor { issuedAt: string; previewId: string }
export interface PreviewAccessReportRequest {
  issuedFrom: string;
  issuedBefore: string;
  limit?: number;
  cursor?: PreviewAccessReportCursor;
}
export interface PreviewAccessReportRow {
  previewId: string;
  projectPublicId: string;
  issuedAt: string;
  expiresAt: string;
  lifecycleStatus: string;
  revokedAt: string | null;
  firstResponsePreparedAt: string | null;
  confirmation: { confirmedAt: string; onTime: boolean } | null;
  correction: { requestedAt: string; status: string; resolvedAt: string | null } | null;
  exceptionCodes: string[];
}
export interface PreviewAccessReport {
  schema: 'kpi09-preview-access-evidence/v1';
  cohort: { issuedFromInclusive: string; issuedBeforeExclusive: string; totalPreviewVersions: number };
  measurement: {
    responsePrepared: { numerator: number; denominator: number; rate: number | null; target: 0.95; result: 'met' | 'not_met' | 'not_evaluated' };
    onTimeConfirmation: { numerator: number; denominator: number; rate: number | null; target: 0.9; result: 'met' | 'not_met' | 'not_evaluated' };
    limitations: string[];
  };
  page: { limit: number; returned: number; completeCohort: boolean; nextCursor: PreviewAccessReportCursor | null };
  rows: PreviewAccessReportRow[];
}

function instant(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
}

function validRequest(request: PreviewAccessReportRequest): { from: string; before: string; limit: number } {
  const from = instant(request.issuedFrom);
  const before = instant(request.issuedBefore);
  const limit = request.limit ?? 100;
  if (!from || !before || Date.parse(from) >= Date.parse(before)) throw new Error('KPI09_COHORT_INVALID');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error('KPI09_LIMIT_INVALID');
  if (request.cursor && (!instant(request.cursor.issuedAt) || !UUID.test(request.cursor.previewId))) {
    throw new Error('KPI09_CURSOR_INVALID');
  }
  return { from, before, limit };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function result(value: number | null, target: number, complete: boolean): 'met' | 'not_met' | 'not_evaluated' {
  if (!complete || value === null) return 'not_evaluated';
  return value >= target ? 'met' : 'not_met';
}

/**
 * Service-only bounded export. Its caller must first establish staff authorization; this function
 * grants no approval, publication, workflow, participant identity, or confirmation authority.
 */
export async function readPreviewAccessReport(
  client: SupabaseClient,
  request: PreviewAccessReportRequest,
): Promise<PreviewAccessReport> {
  const { from, before, limit } = validRequest(request);
  const cohortCount = await client.from('participant_previews')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', from).lt('created_at', before);
  if (cohortCount.error || typeof cohortCount.count !== 'number') {
    throw new Error('KPI09_EVIDENCE_UNAVAILABLE');
  }
  let previewQuery = client.from('participant_previews')
    .select('id,project_id,created_at,expires_at,status,revoked_at')
    .gte('created_at', from).lt('created_at', before)
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .limit(limit + 1);
  if (request.cursor) {
    previewQuery = previewQuery.or(
      `created_at.gt.${request.cursor.issuedAt},and(created_at.eq.${request.cursor.issuedAt},id.gt.${request.cursor.previewId})`,
    );
  }
  const previews = await previewQuery;
  if (previews.error || !Array.isArray(previews.data)) {
    throw new Error('KPI09_EVIDENCE_UNAVAILABLE');
  }
  const pageRows = previews.data.slice(0, limit) as Array<Record<string, unknown>>;
  const previewIds = pageRows.map((row) => String(row.id));
  const projectIds = [...new Set(pageRows.map((row) => String(row.project_id)))];
  const read = async (table: string, columns: string, key: string, ids: string[]) => {
    if (ids.length === 0) return [] as Array<Record<string, unknown>>;
    const response = await client.from(table).select(columns).in(key, ids);
    if (response.error || !Array.isArray(response.data)) throw new Error('KPI09_EVIDENCE_UNAVAILABLE');
    return response.data as unknown as Array<Record<string, unknown>>;
  };
  const [projects, observations, confirmations, corrections] = await Promise.all([
    read('projects', 'id,public_id', 'id', projectIds),
    read('participant_preview_access_observations', 'participant_preview_id,first_response_prepared_at', 'participant_preview_id', previewIds),
    read('participant_preview_confirmations', 'participant_preview_id,confirmed_at', 'participant_preview_id', previewIds),
    read('participant_preview_correction_requests', 'participant_preview_id,requested_at,status,resolved_at', 'participant_preview_id', previewIds),
  ]);
  const by = (rows: Array<Record<string, unknown>>, key: string) => new Map(rows.map((row) => [String(row[key]), row]));
  const projectById = by(projects, 'id');
  const observationByPreview = by(observations, 'participant_preview_id');
  const confirmationByPreview = by(confirmations, 'participant_preview_id');
  const correctionByPreview = by(corrections, 'participant_preview_id');
  const rows: PreviewAccessReportRow[] = pageRows.map((preview) => {
    const previewId = String(preview.id);
    const issuedAt = instant(preview.created_at);
    const expiresAt = instant(preview.expires_at);
    const project = projectById.get(String(preview.project_id));
    const observedAt = instant(observationByPreview.get(previewId)?.first_response_prepared_at);
    const confirmedAt = instant(confirmationByPreview.get(previewId)?.confirmed_at);
    const correction = correctionByPreview.get(previewId);
    const requestedAt = instant(correction?.requested_at);
    const resolvedAt = correction?.resolved_at == null ? null : instant(correction.resolved_at);
    if (!UUID.test(previewId) || !issuedAt || !expiresAt || !project || typeof project.public_id !== 'string'
        || (observationByPreview.has(previewId) && !observedAt)
        || (confirmationByPreview.has(previewId) && !confirmedAt)
        || (correctionByPreview.has(previewId) && (!requestedAt || typeof correction?.status !== 'string'))
        || (correction?.resolved_at != null && !resolvedAt)) throw new Error('KPI09_EVIDENCE_INVALID');
    const revokedAt = preview.revoked_at == null ? null : instant(preview.revoked_at);
    if (preview.revoked_at != null && !revokedAt) throw new Error('KPI09_EVIDENCE_INVALID');
    const exceptionCodes: string[] = [];
    if (!observedAt) exceptionCodes.push('RESPONSE_PREPARATION_NOT_RECORDED');
    if (!confirmedAt && !requestedAt) exceptionCodes.push('PARTICIPANT_RESPONSE_NOT_RECORDED');
    if (confirmedAt && Date.parse(confirmedAt) > Date.parse(expiresAt)) exceptionCodes.push('CONFIRMATION_AFTER_EXPIRY');
    if (requestedAt) exceptionCodes.push('CORRECTION_REQUESTED');
    if (preview.status === 'revoked') exceptionCodes.push('PREVIEW_REVOKED');
    return {
      previewId, projectPublicId: project.public_id, issuedAt, expiresAt,
      lifecycleStatus: String(preview.status), revokedAt,
      firstResponsePreparedAt: observedAt,
      confirmation: confirmedAt ? { confirmedAt, onTime: Date.parse(confirmedAt) <= Date.parse(expiresAt) } : null,
      correction: requestedAt ? { requestedAt, status: String(correction!.status), resolvedAt } : null,
      exceptionCodes,
    };
  });
  const hasMore = previews.data.length > limit;
  const completeCohort = !request.cursor && !hasMore && cohortCount.count === rows.length;
  const prepared = rows.filter((row) => row.firstResponsePreparedAt).length;
  const onTime = rows.filter((row) => row.confirmation?.onTime).length;
  const preparedRate = rate(prepared, rows.length);
  const confirmationRate = rate(onTime, rows.length);
  const last = rows.at(-1);
  return {
    schema: 'kpi09-preview-access-evidence/v1',
    cohort: { issuedFromInclusive: from, issuedBeforeExclusive: before, totalPreviewVersions: cohortCount.count },
    measurement: {
      responsePrepared: { numerator: prepared, denominator: rows.length, rate: preparedRate, target: 0.95, result: result(preparedRate, 0.95, completeCohort) },
      onTimeConfirmation: { numerator: onTime, denominator: rows.length, rate: confirmationRate, target: 0.9, result: result(confirmationRate, 0.9, completeCohort) },
      limitations: [
        'A prepared server response is not proof of network delivery, human reading, or participant identity; bots and prefetch can qualify.',
        'No observation is backfilled. Not recorded can mean no qualifying GET or that access predates evidence collection.',
        'Confirmation and correction are explicit exact-preview records; neither approves, publishes, or changes project workflow.',
        'Threshold results are evaluated only when this bounded page contains the complete requested cohort.',
      ],
    },
    page: {
      limit, returned: rows.length, completeCohort,
      nextCursor: hasMore && last ? { issuedAt: last.issuedAt, previewId: last.previewId } : null,
    },
    rows,
  };
}
