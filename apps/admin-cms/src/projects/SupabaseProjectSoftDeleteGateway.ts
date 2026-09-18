import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { WORKFLOW_STATUSES, type WorkflowStatus } from '../domain/workflowStatus';
import {
  SOFT_DELETE_DECISION_CODES,
  type SoftDeleteDecisionCode,
  type SoftDeleteDisposition,
  type SoftDeleteExecutionResult,
  type SoftDeletePreflightItem,
} from './projectSoftDelete';
import type { ProjectSoftDeleteGateway } from './projectSoftDeleteService';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && WORKFLOW_STATUSES.includes(value as WorkflowStatus);
}

function isDecisionCode(value: unknown): value is SoftDeleteDecisionCode {
  return typeof value === 'string' && SOFT_DELETE_DECISION_CODES.includes(value as SoftDeleteDecisionCode);
}

function parsePreflightItem(value: unknown): SoftDeletePreflightItem | null {
  if (!isRecord(value)) return null;
  const disposition = value.disposition;
  if (!['eligible', 'blocked', 'already_deleted'].includes(String(disposition))) return null;
  if (
    typeof value.publicId !== 'string'
    || typeof value.title !== 'string'
    || (value.status !== null && !isWorkflowStatus(value.status))
    || (value.updatedAt !== null && typeof value.updatedAt !== 'string')
    || !isDecisionCode(value.reasonCode)
    || typeof value.reason !== 'string'
    || typeof value.previouslyPublished !== 'boolean'
  ) return null;
  return {
    publicId: value.publicId,
    title: value.title,
    status: value.status,
    updatedAt: value.updatedAt,
    disposition: disposition as SoftDeleteDisposition,
    reasonCode: value.reasonCode,
    reason: value.reason,
    previouslyPublished: value.previouslyPublished,
  };
}

function parseExecutionResult(value: unknown): SoftDeleteExecutionResult | null {
  if (!isRecord(value) || typeof value.resultCode !== 'string') return null;
  if (value.resultCode === 'DELETED') {
    if (
      typeof value.publicId !== 'string'
      || value.status !== 'deleted'
      || !isWorkflowStatus(value.fromStatus)
      || typeof value.deletedAt !== 'string'
      || typeof value.auditRecordId !== 'string'
    ) return null;
    return value as unknown as SoftDeleteExecutionResult;
  }
  if (value.resultCode === 'ALREADY_DELETED') {
    if (typeof value.publicId !== 'string' || value.status !== 'deleted' || typeof value.deletedAt !== 'string') return null;
    return value as unknown as SoftDeleteExecutionResult;
  }
  if (
    value.resultCode !== 'STALE_VERSION'
    && value.resultCode !== 'PROJECT_NOT_FOUND'
    && (!isDecisionCode(value.resultCode) || value.resultCode === 'ELIGIBLE')
  ) return null;
  return value as unknown as SoftDeleteExecutionResult;
}

export class SupabaseProjectSoftDeleteGateway implements ProjectSoftDeleteGateway {
  constructor(private readonly supabase: SupabaseClient) {}

  async preflight(publicIds: string[], adminId: string): Promise<SoftDeletePreflightItem[]> {
    const { data, error } = await this.supabase.rpc('get_project_soft_delete_preflight', {
      p_public_ids: publicIds,
      p_admin_id: adminId,
    });
    if (error || !isRecord(data) || !Array.isArray(data.items)) {
      throw new Error('Project soft delete preflight failed.');
    }
    const items = data.items.map(parsePreflightItem);
    if (items.some((item) => item === null)) {
      throw new Error('Project soft delete preflight response is invalid.');
    }
    return items as SoftDeletePreflightItem[];
  }

  async execute(params: {
    publicId: string;
    expectedUpdatedAt: string;
    adminId: string;
  }): Promise<SoftDeleteExecutionResult> {
    const { data, error } = await this.supabase.rpc('soft_delete_project_if_current', {
      p_public_id: params.publicId,
      p_expected_updated_at: params.expectedUpdatedAt,
      p_admin_id: params.adminId,
    });
    const result = parseExecutionResult(data);
    if (error || !result) {
      throw new Error('Project soft delete execution failed.');
    }
    return result;
  }
}
