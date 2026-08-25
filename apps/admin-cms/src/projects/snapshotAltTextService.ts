import { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { AdminPermission } from '../auth/authTypes';
import { hasPermission } from '../auth/permissions';
import {
  SnapshotAltTextActionResult,
  SnapshotAltTextErrorCode,
  SnapshotAltTextInput,
  snapshotAltTextInputSchema,
  snapshotAltTextResultMessage,
} from './snapshotAltText';

export interface SnapshotAltTextGateway {
  updateSnapshotAltTextAtomically(input: SnapshotAltTextInput, actorAdminUserId: string): Promise<unknown>;
}

/**
 * The RPC's own result contract. `NO_CHANGES` is a success from the staff point of view — the
 * stored value already says what they wanted it to say — and the RPC deliberately writes no audit
 * row for it, so re-saving an unchanged description never fabricates evidence of an edit.
 */
const rpcResponseSchema = z.object({
  resultCode: z.enum([
    'SUCCESS',
    'NO_CHANGES',
    'PROJECT_NOT_FOUND',
    'SNAPSHOT_MEDIA_NOT_FOUND',
    'STALE_VERSION',
    'APPROVAL_REOPEN_REQUIRED',
    'PUBLISHED_PROJECT_LOCKED',
    'ALT_TEXT_TOO_LONG',
    'VALIDATION_FAILED',
    'PERMISSION_DENIED',
  ]),
  snapshotAltText: z.string().optional(),
  mediaAssetId: z.string().optional(),
  expectedUpdatedAt: z.string().optional(),
  auditRecordId: z.string().optional(),
});

function failure(code: SnapshotAltTextErrorCode, fieldErrors?: Record<string, string[]>): SnapshotAltTextActionResult {
  return { ok: false, code, message: snapshotAltTextResultMessage(code), ...(fieldErrors ? { fieldErrors } : {}) };
}

export async function saveSnapshotAltText(
  gateway: SnapshotAltTextGateway,
  rawInput: unknown,
  actorAdminUserId: string,
): Promise<SnapshotAltTextActionResult> {
  const parsed = snapshotAltTextInputSchema.safeParse(rawInput);
  if (!parsed.success) return failure('VALIDATION_FAILED', parsed.error.flatten().fieldErrors);

  let rawResponse: unknown;
  try {
    rawResponse = await gateway.updateSnapshotAltTextAtomically(parsed.data, actorAdminUserId);
  } catch (error) {
    console.error('[Snapshot alt text RPC failure]', error instanceof Error ? error.message : 'unknown');
    return failure('PERSISTENCE_FAILED');
  }

  const response = rpcResponseSchema.safeParse(rawResponse);
  if (!response.success) return failure('INTERNAL_FAILURE');

  switch (response.data.resultCode) {
    case 'SUCCESS':
    case 'NO_CHANGES': {
      const { snapshotAltText, mediaAssetId, expectedUpdatedAt } = response.data;
      if (!snapshotAltText || !mediaAssetId || !expectedUpdatedAt) return failure('INTERNAL_FAILURE');
      return {
        ok: true,
        snapshot: { publicId: parsed.data.publicId, mediaAssetId, snapshotAltText, expectedUpdatedAt },
      };
    }
    case 'PROJECT_NOT_FOUND': return failure('PROJECT_NOT_FOUND');
    case 'SNAPSHOT_MEDIA_NOT_FOUND': return failure('SNAPSHOT_MEDIA_NOT_FOUND');
    case 'STALE_VERSION': return failure('STALE_VERSION');
    case 'APPROVAL_REOPEN_REQUIRED': return failure('APPROVAL_REOPEN_REQUIRED');
    case 'PUBLISHED_PROJECT_LOCKED': return failure('PUBLISHED_PROJECT_LOCKED');
    case 'ALT_TEXT_TOO_LONG': return failure('ALT_TEXT_TOO_LONG');
    case 'VALIDATION_FAILED': return failure('VALIDATION_FAILED');
    case 'PERMISSION_DENIED': return failure('PERMISSION_DENIED');
  }
}

/**
 * Keeps authorization ahead of persistence. Editing accessibility metadata is an editing action, so
 * it requires `projects.edit` — Admin and Editor hold it, a reviewer-only identity does not. The
 * database rechecks the same authority independently; neither layer trusts the browser for it.
 */
export async function saveAuthorizedSnapshotAltText(
  permissions: AdminPermission[],
  gateway: SnapshotAltTextGateway,
  rawInput: unknown,
  actorAdminUserId: string,
): Promise<SnapshotAltTextActionResult> {
  if (!hasPermission(permissions, 'projects.edit')) return failure('PERMISSION_DENIED');
  return saveSnapshotAltText(gateway, rawInput, actorAdminUserId);
}

export class SupabaseSnapshotAltTextGateway implements SnapshotAltTextGateway {
  constructor(private readonly supabase: SupabaseClient) {}

  async updateSnapshotAltTextAtomically(input: SnapshotAltTextInput, actorAdminUserId: string): Promise<unknown> {
    const { data, error } = await this.supabase.rpc('update_snapshot_image_alt_text', {
      p_public_id: input.publicId,
      p_media_asset_id: input.mediaAssetId,
      p_alt_text: input.snapshotAltText,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_admin_id: actorAdminUserId,
    });
    if (error) throw new Error('Snapshot alt text update RPC failed');
    return data;
  }
}
