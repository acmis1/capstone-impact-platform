import { describe, expect, it, vi } from 'vitest';

import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';
import type { AdminPermission } from '../auth/authTypes';
import { saveAuthorizedSnapshotAltText, saveSnapshotAltText } from './snapshotAltTextService';

const MAX = ACCESSIBLE_CONTENT_LIMITS.snapshotAltText;
const VALID_ALT = 'Photograph of the assembled prototype rig on a laboratory bench.';
const EXPECTED_UPDATED_AT = '2026-08-14T00:00:00.000Z';
const NEXT_UPDATED_AT = '2026-08-14T01:00:00.000Z';
const MEDIA_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';

const EDIT_PERMISSIONS = ['projects.edit'] as unknown as AdminPermission[];
const REVIEW_ONLY_PERMISSIONS = ['projects.review'] as unknown as AdminPermission[];

const input = (overrides: Record<string, unknown> = {}) => ({
  publicId: '2026-synthetic',
  mediaAssetId: MEDIA_ID,
  snapshotAltText: VALID_ALT,
  expectedUpdatedAt: EXPECTED_UPDATED_AT,
  ...overrides,
});

function gatewayReturning(response: unknown) {
  return { updateSnapshotAltTextAtomically: vi.fn().mockResolvedValue(response) };
}

const successResponse = {
  resultCode: 'SUCCESS',
  snapshotAltText: VALID_ALT,
  mediaAssetId: MEDIA_ID,
  expectedUpdatedAt: NEXT_UPDATED_AT,
  auditRecordId: '66666666-6666-4666-8666-666666666666',
};

describe('snapshot alt text save service', () => {
  it('sends the trimmed value and the caller-independent actor id to the RPC', async () => {
    const gateway = gatewayReturning(successResponse);
    const result = await saveSnapshotAltText(gateway, input({ snapshotAltText: `  ${VALID_ALT}  ` }), ADMIN_ID);

    expect(result.ok).toBe(true);
    expect(gateway.updateSnapshotAltTextAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotAltText: VALID_ALT }),
      ADMIN_ID,
    );
  });

  it('returns the advanced project version so the next save is not immediately stale', async () => {
    const result = await saveSnapshotAltText(gatewayReturning(successResponse), input(), ADMIN_ID);
    expect(result.ok && result.snapshot.expectedUpdatedAt).toBe(NEXT_UPDATED_AT);
    expect(result.ok && result.snapshot.mediaAssetId).toBe(MEDIA_ID);
  });

  it('treats an unchanged value as a success without inventing an edit', async () => {
    const result = await saveSnapshotAltText(
      gatewayReturning({ ...successResponse, resultCode: 'NO_CHANGES', auditRecordId: undefined }),
      input(),
      ADMIN_ID,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a blank value before reaching the database', async () => {
    const gateway = gatewayReturning(successResponse);
    const result = await saveSnapshotAltText(gateway, input({ snapshotAltText: '   \n ' }), ADMIN_ID);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('VALIDATION_FAILED');
    expect(gateway.updateSnapshotAltTextAtomically).not.toHaveBeenCalled();
  });

  it('accepts the exact maximum and rejects one character beyond it', async () => {
    const atMax = await saveSnapshotAltText(
      gatewayReturning({ ...successResponse, snapshotAltText: 'a'.repeat(MAX) }),
      input({ snapshotAltText: 'a'.repeat(MAX) }),
      ADMIN_ID,
    );
    expect(atMax.ok).toBe(true);

    const gateway = gatewayReturning(successResponse);
    const overMax = await saveSnapshotAltText(gateway, input({ snapshotAltText: 'a'.repeat(MAX + 1) }), ADMIN_ID);
    expect(!overMax.ok && overMax.code).toBe('VALIDATION_FAILED');
    expect(gateway.updateSnapshotAltTextAtomically).not.toHaveBeenCalled();
  });

  it('rejects an unexpected extra field rather than forwarding it', async () => {
    const gateway = gatewayReturning(successResponse);

    const result = await saveSnapshotAltText(
      gateway,
      input({ unexpectedField: 'not-allowed' }),
      ADMIN_ID,
    );

    expect(!result.ok && result.code).toBe('VALIDATION_FAILED');
    expect(gateway.updateSnapshotAltTextAtomically).not.toHaveBeenCalled();
  });

  it.each([
    ['PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND'],
    ['SNAPSHOT_MEDIA_NOT_FOUND', 'SNAPSHOT_MEDIA_NOT_FOUND'],
    ['STALE_VERSION', 'STALE_VERSION'],
    ['APPROVAL_REOPEN_REQUIRED', 'APPROVAL_REOPEN_REQUIRED'],
    ['PUBLISHED_PROJECT_LOCKED', 'PUBLISHED_PROJECT_LOCKED'],
    ['ALT_TEXT_TOO_LONG', 'ALT_TEXT_TOO_LONG'],
    ['VALIDATION_FAILED', 'VALIDATION_FAILED'],
    ['PERMISSION_DENIED', 'PERMISSION_DENIED'],
  ])('maps the %s database result to a bounded staff message', async (resultCode, expected) => {
    const result = await saveSnapshotAltText(gatewayReturning({ resultCode }), input(), ADMIN_ID);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe(expected);
    // Never leaks SQL, identifiers, or storage paths.
    expect(!result.ok && result.message).not.toMatch(/select|update_snapshot_image_alt_text|drafts\//i);
  });

  it('fails closed on an unrecognised database response', async () => {
    const result = await saveSnapshotAltText(gatewayReturning({ resultCode: 'SOMETHING_NEW' }), input(), ADMIN_ID);
    expect(!result.ok && result.code).toBe('INTERNAL_FAILURE');
  });

  it('reports a transport failure without surfacing the underlying error', async () => {
    const gateway = { updateSnapshotAltTextAtomically: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const result = await saveSnapshotAltText(gateway, input(), ADMIN_ID);
    expect(!result.ok && result.code).toBe('PERSISTENCE_FAILED');
    expect(!result.ok && result.message).not.toContain('connection refused');
  });
});

describe('snapshot alt text authorization', () => {
  it('blocks direct content edits even for an identity holding projects.edit', async () => {
    const gateway = gatewayReturning(successResponse);
    const result = await saveAuthorizedSnapshotAltText(EDIT_PERMISSIONS, gateway, input(), ADMIN_ID);
    expect(result).toMatchObject({ ok: false, code: 'PARTICIPANT_CONTENT_OWNED' });
    expect(gateway.updateSnapshotAltTextAtomically).not.toHaveBeenCalled();
  });

  it('denies a reviewer-only identity before any persistence attempt', async () => {
    const gateway = gatewayReturning(successResponse);
    const result = await saveAuthorizedSnapshotAltText(REVIEW_ONLY_PERMISSIONS, gateway, input(), ADMIN_ID);
    expect(!result.ok && result.code).toBe('PERMISSION_DENIED');
    expect(gateway.updateSnapshotAltTextAtomically).not.toHaveBeenCalled();
  });

  it('denies an identity holding no permissions at all', async () => {
    const gateway = gatewayReturning(successResponse);
    const result = await saveAuthorizedSnapshotAltText([], gateway, input(), ADMIN_ID);
    expect(!result.ok && result.code).toBe('PERMISSION_DENIED');
    expect(gateway.updateSnapshotAltTextAtomically).not.toHaveBeenCalled();
  });
});
