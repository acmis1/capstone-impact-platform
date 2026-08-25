import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { SupabaseBulkProjectReviewGateway } from './SupabaseBulkProjectReviewGateway';

/**
 * The version-fenced wrapper returns the workflow authority's own bounded rule code. These tests
 * pin the translation of that code into a distinct staff-facing outcome, so a blocked project is
 * never reduced to one undifferentiated "workflow" sentence, and an unrecognized code can never
 * carry database detail to the browser.
 */
function gatewayWithRpc(response: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({ data: response.data ?? null, error: response.error ?? null });
  const supabase = { rpc } as unknown as SupabaseClient;
  return { gateway: new SupabaseBulkProjectReviewGateway(supabase, 'project-drafts-private'), rpc };
}

const EXECUTE_PARAMS = {
  action: 'approve' as const,
  publicId: 'synthetic-2026-0001',
  expectedUpdatedAt: '2026-08-24T00:00:00.000Z',
  adminId: '11111111-1111-4111-8111-111111111111',
};

describe('SupabaseBulkProjectReviewGateway execution outcomes', () => {
  it('passes the server-derived actor and expected version to the fenced wrapper', async () => {
    const { gateway, rpc } = gatewayWithRpc({
      data: { resultCode: 'SUCCESS', publicId: EXECUTE_PARAMS.publicId, status: 'approved', auditRecordId: 'audit-1' },
    });

    const result = await gateway.executeAction(EXECUTE_PARAMS);

    expect(rpc).toHaveBeenCalledWith('perform_project_workflow_action_if_current', {
      p_public_id: EXECUTE_PARAMS.publicId,
      p_action: 'approve',
      p_comments: null,
      p_admin_id: EXECUTE_PARAMS.adminId,
      p_expected_updated_at: EXECUTE_PARAMS.expectedUpdatedAt,
    });
    expect(result).toEqual({ resultCode: 'SUCCESS', status: 'approved', auditRecorded: true });
  });

  it.each([
    ['REVIEW_TRANSITION_INVALID', 'The project is no longer in a workflow state that allows this action.'],
    ['REVIEW_PERMISSION_DENIED', 'Your account is not permitted to apply this action to this project.'],
    ['MEDIA_ACCESSIBILITY_REQUIRED', 'Required image alternative text is missing.'],
    ['READINESS_BLOCKED', 'The project has unresolved readiness blockers.'],
  ])('reports %s with its own distinct staff-facing reason', async (reasonCode, message) => {
    const { gateway } = gatewayWithRpc({
      data: { resultCode: 'BLOCKED', publicId: EXECUTE_PARAMS.publicId, status: 'submitted', reasonCode },
    });

    const result = await gateway.executeAction(EXECUTE_PARAMS);

    expect(result.resultCode).toBe('BLOCKED');
    expect(result.auditRecorded).toBe(false);
    expect(result.reason).toEqual({ code: reasonCode, message });
  });

  it('does not collapse two different rule codes onto the same message', async () => {
    const first = await gatewayWithRpc({
      data: { resultCode: 'BLOCKED', status: 'submitted', reasonCode: 'REVIEW_TRANSITION_INVALID' },
    }).gateway.executeAction(EXECUTE_PARAMS);
    const second = await gatewayWithRpc({
      data: { resultCode: 'BLOCKED', status: 'submitted', reasonCode: 'READINESS_BLOCKED' },
    }).gateway.executeAction(EXECUTE_PARAMS);

    expect(first.reason?.message).not.toBe(second.reason?.message);
  });

  it('keeps an unrecognized rule code bounded and generic', async () => {
    const { gateway } = gatewayWithRpc({
      data: {
        resultCode: 'BLOCKED',
        status: 'submitted',
        reasonCode: 'SOME_FUTURE_RULE_CODE',
      },
    });

    const result = await gateway.executeAction(EXECUTE_PARAMS);

    expect(result.reason).toEqual({
      code: 'SOME_FUTURE_RULE_CODE',
      message: 'The project did not pass the current workflow checks.',
    });
  });

  it('reports a re-raised infrastructure fault as failed rather than as a workflow decision', async () => {
    // The wrapper re-raises anything that is not an explicit workflow rule violation, so the
    // client sees a transport error here, not a BLOCKED payload.
    const { gateway } = gatewayWithRpc({ error: { message: 'deadlock detected', code: '40P01' } });

    const result = await gateway.executeAction(EXECUTE_PARAMS);

    expect(result.resultCode).toBe('FAILED');
    expect(result.auditRecorded).toBe(false);
    expect(result.reason?.code).toBe('WORKFLOW_EXECUTION_FAILED');
    expect(JSON.stringify(result)).not.toContain('deadlock');
    expect(JSON.stringify(result)).not.toContain('40P01');
  });

  it('reports stale and already-complete wrapper outcomes without an audit record', async () => {
    const stale = await gatewayWithRpc({
      data: { resultCode: 'STALE_VERSION', status: 'submitted' },
    }).gateway.executeAction(EXECUTE_PARAMS);
    const alreadyComplete = await gatewayWithRpc({
      data: { resultCode: 'ALREADY_COMPLETE', status: 'approved' },
    }).gateway.executeAction(EXECUTE_PARAMS);

    expect(stale).toEqual({
      resultCode: 'STALE_VERSION',
      status: 'submitted',
      auditRecorded: false,
      reason: { code: 'STALE_VERSION', message: 'The project changed before the action could be applied.' },
    });
    expect(alreadyComplete).toEqual({
      resultCode: 'ALREADY_COMPLETE',
      status: 'approved',
      auditRecorded: false,
    });
  });

  it('treats a success payload without an audit record identifier as blocked', async () => {
    const { gateway } = gatewayWithRpc({
      data: { resultCode: 'SUCCESS', status: 'approved' },
    });

    const result = await gateway.executeAction(EXECUTE_PARAMS);

    expect(result.resultCode).toBe('BLOCKED');
    expect(result.auditRecorded).toBe(false);
  });
});
