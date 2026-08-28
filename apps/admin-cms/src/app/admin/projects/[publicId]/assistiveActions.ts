'use server';

import { z } from 'zod';

import {
  cancelAssistiveValidation,
  enqueueAssistiveValidation,
  resolveAssistiveExecutionAvailability,
  loadAssistiveInspection,
  recordAssistiveFindingDisposition,
  SupabaseAssistiveInputRepository,
  SupabaseAssistiveJobRepository,
  SupabaseAssistiveValidationRepository,
  SupabaseAssistiveWorkerHeartbeatRepository,
  SupabaseAssistiveExecutionControlRepository,
  assistiveInspectionResponseSchema,
  type AssistiveInspectionView,
  type AssistiveRecordableDisposition,
  assistiveRecordableDispositionSchema,
  ASSISTIVE_PIPELINE_VERSION,
} from '../../../../assistive-validation';
import { AdminAuthError } from '../../../../auth/authTypes';
import { hasPermission } from '../../../../auth/permissions';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { getServerEnv } from '../../../../lib/env';
import { createSupabaseAdminClient } from '../../../../lib/supabase/admin';

const uuid = z.uuid();
const publicIdSchema = z.string().min(1).max(50);

export type RunAssistiveChecksActionResult =
  | { ok: true; runId: string; status: string }
  | { ok: false; code: string; message: string };

export type CancelAssistiveChecksActionResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Privacy Invariant: internal staff identity UUIDs (reviewedBy) are NEVER returned to browser.
 */
export type RecordAssistiveDispositionActionResult =
  | { ok: true; findingId: string; disposition: AssistiveRecordableDisposition }
  | { ok: false; code: string; message: string };

export type GetAssistiveInspectionActionResult =
  | { ok: true; found: false }
  | { ok: true; found: true; inspection: AssistiveInspectionView }
  | { ok: false; code: string; message: string };

async function resolveProjectDbId(supabase: ReturnType<typeof createSupabaseAdminClient>, publicId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('id')
    .eq('public_id', publicId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error || !data?.id) return null;
  return data.id;
}

export async function runAssistiveChecksAction(publicIdInput: unknown): Promise<RunAssistiveChecksActionResult> {
  try {
    const context = await requireAdmin();
    if (!hasPermission(context.permissions, 'projects.read')) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'You do not have permission to view this project.' };
    }

    const env = getServerEnv();
    const supabase = createSupabaseAdminClient();
    const availability = await resolveAssistiveExecutionAvailability(
      env.supabaseUrl,
      new SupabaseAssistiveWorkerHeartbeatRepository(
        supabase,
        process.env.CAPSTONE_DEPLOYMENT_VERSION ?? process.env.RENDER_GIT_COMMIT ?? '',
      ),
      new SupabaseAssistiveExecutionControlRepository(supabase),
    );
    if (!availability.canEnqueue) {
      return {
        ok: false,
        code: availability.state === 'BUDGET_REACHED' ? 'EXECUTION_BUDGET_REACHED' : 'EXECUTION_UNAVAILABLE',
        message: availability.message
          ?? 'Assistive checks are temporarily unavailable because the processing worker is not ready.',
      };
    }

    const publicIdParsed = publicIdSchema.safeParse(publicIdInput);
    if (!publicIdParsed.success) {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid project identifier.' };
    }

    const projectId = await resolveProjectDbId(supabase, publicIdParsed.data);
    if (!projectId) {
      return { ok: false, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' };
    }

    const result = await enqueueAssistiveValidation(
      new SupabaseAssistiveJobRepository(supabase),
      new SupabaseAssistiveInputRepository(supabase),
      {
        projectId,
        actorAdminUserId: context.adminUserId,
        privateBucket: env.SUPABASE_DRAFT_BUCKET,
        pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
      },
    );

    if (result.resultCode === 'ENQUEUED' || result.resultCode === 'ALREADY_QUEUED' || result.resultCode === 'ALREADY_COMPLETED') {
      return { ok: true, runId: result.runId, status: result.status };
    }

    if (result.resultCode === 'MEDIA_INVALID') {
      return { ok: false, code: 'MEDIA_INVALID', message: 'No valid poster PDF or image file found for assistive checks.' };
    }

    return { ok: false, code: result.resultCode, message: 'Could not enqueue assistive validation.' };
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'Authentication required.' };
    }
    console.error('[runAssistiveChecksAction error]:', error instanceof Error ? error.message : 'UNKNOWN');
    return { ok: false, code: 'INTERNAL_FAILURE', message: 'An unexpected error occurred while starting assistive checks.' };
  }
}

export async function cancelAssistiveChecksAction(publicIdInput: unknown, runIdInput: unknown): Promise<CancelAssistiveChecksActionResult> {
  try {
    const context = await requireAdmin();
    if (!hasPermission(context.permissions, 'projects.read')) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'You do not have permission to view this project.' };
    }

    const publicIdParsed = publicIdSchema.safeParse(publicIdInput);
    const runIdParsed = uuid.safeParse(runIdInput);
    if (!publicIdParsed.success || !runIdParsed.success) {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid cancel parameters.' };
    }

    const supabase = createSupabaseAdminClient();
    const projectId = await resolveProjectDbId(supabase, publicIdParsed.data);
    if (!projectId) {
      return { ok: false, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' };
    }

    // Verify run belongs to the requested project with strict schema validation
    const validationRepo = new SupabaseAssistiveValidationRepository(supabase);
    const rawInspection = await validationRepo.loadInspection(projectId, ASSISTIVE_PIPELINE_VERSION, runIdParsed.data);
    const inspectionParsed = assistiveInspectionResponseSchema.safeParse(rawInspection);
    if (!inspectionParsed.success || inspectionParsed.data.resultCode !== 'FOUND') {
      return { ok: false, code: 'NOT_FOUND', message: 'Assistive run not found for this project.' };
    }

    const jobRepo = new SupabaseAssistiveJobRepository(supabase);
    const result = await cancelAssistiveValidation(jobRepo, runIdParsed.data, context.adminUserId);

    if (result.resultCode === 'CANCELLED' || result.resultCode === 'ALREADY_TERMINAL' || result.resultCode === 'CANCELLATION_REQUESTED') {
      return { ok: true };
    }

    return { ok: false, code: result.resultCode, message: 'Could not cancel assistive validation.' };
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'Authentication required.' };
    }
    console.error('[cancelAssistiveChecksAction error]:', error instanceof Error ? error.message : 'UNKNOWN');
    return { ok: false, code: 'INTERNAL_FAILURE', message: 'An unexpected error occurred while cancelling assistive checks.' };
  }
}

export async function recordAssistiveDispositionAction(
  publicIdInput: unknown,
  runIdInput: unknown,
  findingIdInput: unknown,
  dispositionInput: unknown,
): Promise<RecordAssistiveDispositionActionResult> {
  try {
    const context = await requireAdmin();
    if (!hasPermission(context.permissions, 'projects.review')) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'Your role cannot record reviewer dispositions.' };
    }

    const publicIdParsed = publicIdSchema.safeParse(publicIdInput);
    const runIdParsed = uuid.safeParse(runIdInput);
    const findingIdParsed = uuid.safeParse(findingIdInput);
    const dispositionParsed = assistiveRecordableDispositionSchema.safeParse(dispositionInput);

    if (!publicIdParsed.success || !runIdParsed.success || !findingIdParsed.success || !dispositionParsed.success) {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid disposition parameters.' };
    }

    const supabase = createSupabaseAdminClient();
    const projectId = await resolveProjectDbId(supabase, publicIdParsed.data);
    if (!projectId) {
      return { ok: false, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' };
    }

    // Verify run and finding association with strict schema parsing
    const validationRepo = new SupabaseAssistiveValidationRepository(supabase);
    const rawInspection = await validationRepo.loadInspection(projectId, ASSISTIVE_PIPELINE_VERSION, runIdParsed.data);
    const inspectionParsed = assistiveInspectionResponseSchema.safeParse(rawInspection);
    if (
      !inspectionParsed.success ||
      inspectionParsed.data.resultCode !== 'FOUND' ||
      !inspectionParsed.data.findings.some((f) => f.findingId === findingIdParsed.data)
    ) {
      return { ok: false, code: 'FINDING_NOT_FOUND', message: 'Finding not found for this project run.' };
    }

    const result = await recordAssistiveFindingDisposition(
      validationRepo,
      findingIdParsed.data,
      context.adminUserId,
      dispositionParsed.data,
    );

    if (result.ok) {
      return {
        ok: true,
        findingId: result.findingId,
        disposition: result.disposition as AssistiveRecordableDisposition,
      };
    }

    return { ok: false, code: result.code, message: result.message };
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'Authentication required.' };
    }
    console.error('[recordAssistiveDispositionAction error]:', error instanceof Error ? error.message : 'UNKNOWN');
    return { ok: false, code: 'INTERNAL_FAILURE', message: 'An unexpected error occurred while saving disposition.' };
  }
}

export async function getAssistiveInspectionAction(publicIdInput: unknown, runIdInput?: unknown): Promise<GetAssistiveInspectionActionResult> {
  try {
    const context = await requireAdmin();
    if (!hasPermission(context.permissions, 'projects.read')) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'You do not have permission to view this project.' };
    }

    const publicIdParsed = publicIdSchema.safeParse(publicIdInput);
    const runIdParsed = runIdInput ? uuid.safeParse(runIdInput) : undefined;
    if (!publicIdParsed.success || (runIdParsed && !runIdParsed.success)) {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid query parameters.' };
    }

    const supabase = createSupabaseAdminClient();
    const projectId = await resolveProjectDbId(supabase, publicIdParsed.data);
    if (!projectId) {
      return { ok: false, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' };
    }

    const env = getServerEnv();
    const result = await loadAssistiveInspection(
      new SupabaseAssistiveValidationRepository(supabase),
      new SupabaseAssistiveInputRepository(supabase),
      {
        projectId,
        pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
        runId: runIdParsed?.data,
        privateBucket: env.SUPABASE_DRAFT_BUCKET,
      },
    );

    if (result.ok) {
      if (!result.found) return { ok: true, found: false };
      return { ok: true, found: true, inspection: result.inspection };
    }

    return { ok: false, code: result.code, message: result.message };
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return { ok: false, code: 'PERMISSION_DENIED', message: 'Authentication required.' };
    }
    console.error('[getAssistiveInspectionAction error]:', error instanceof Error ? error.message : 'UNKNOWN');
    return { ok: false, code: 'INTERNAL_FAILURE', message: 'An unexpected error occurred while loading inspection data.' };
  }
}
