import { describe, expect, it } from 'vitest';
import { staffLifecycleMessage, validateStaffLifecycleInput } from './staffLifecycle';

describe('validateStaffLifecycleInput', () => {
  it('normalizes a target and canonicalizes a complete replacement role set', () => {
    expect(validateStaffLifecycleInput({
      action: 'replace_roles',
      targetEmail: ' Staff@Example.COM ',
      expectedVersion: 3,
      roles: ['editor', 'admin', 'editor'],
    })).toEqual({
      valid: true,
      data: {
        action: 'replace_roles',
        targetEmail: 'staff@example.com',
        expectedVersion: 3,
        roles: ['admin', 'editor'],
      },
    });
  });

  it.each(['deactivate', 'reconcile'] as const)('accepts %s without a role payload', (action) => {
    expect(validateStaffLifecycleInput({
      action,
      targetEmail: 'staff@example.com',
      expectedVersion: 1,
    }).valid).toBe(true);
  });

  it('requires recognized roles for reactivation', () => {
    expect(validateStaffLifecycleInput({
      action: 'reactivate',
      targetEmail: 'staff@example.com',
      expectedVersion: 2,
      roles: ['reviewer'],
    }).valid).toBe(true);
  });

  it.each([
    ['internal identity', {
      action: 'deactivate', targetEmail: 'staff@example.com', expectedVersion: 1,
      authUserId: 'internal',
    }],
    ['unknown role', {
      action: 'replace_roles', targetEmail: 'staff@example.com', expectedVersion: 1,
      roles: ['owner'],
    }],
    ['empty roles', {
      action: 'reactivate', targetEmail: 'staff@example.com', expectedVersion: 1, roles: [],
    }],
    ['roles on deactivate', {
      action: 'deactivate', targetEmail: 'staff@example.com', expectedVersion: 1,
      roles: ['reviewer'],
    }],
    ['unsafe version', {
      action: 'deactivate', targetEmail: 'staff@example.com', expectedVersion: Number.MAX_VALUE,
    }],
    ['malformed email', {
      action: 'deactivate', targetEmail: 'not-an-email', expectedVersion: 1,
    }],
  ])('rejects %s', (_label, input) => {
    expect(validateStaffLifecycleInput(input)).toEqual({
      valid: false,
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('staffLifecycleMessage', () => {
  it('states DB deactivation truthfully when provider synchronization fails', () => {
    expect(staffLifecycleMessage('UPDATED_PROVIDER_ATTENTION', {
      email: 'staff@example.com',
      roles: [],
      status: 'deactivated',
      version: 2,
      providerSync: 'attention_required',
    })).toMatch(/^Admin\/CMS access is deactivated\./);
  });

  it('never exposes provider or database internals', () => {
    for (const code of [
      'UPDATED',
      'UPDATED_PROVIDER_ATTENTION',
      'SELF_MODIFICATION_DENIED',
      'LAST_ADMIN_PROTECTED',
      'STALE_VERSION',
      'LIFECYCLE_FAILED',
    ] as const) {
      const message = staffLifecycleMessage(code).toLowerCase();
      for (const forbidden of ['supabase', 'auth_user_id', 'admin_user_id', 'uuid', 'token', 'sql']) {
        expect(message).not.toContain(forbidden);
      }
    }
  });
});
