import { describe, expect, it, vi } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { provisionStaffMember, type StaffProvisioningRequestContext } from './staffProvisioningService';

const ADMIN_PERMISSIONS = getPermissionsForRoles(['admin']);
const REVIEWER_PERMISSIONS = getPermissionsForRoles(['reviewer']);
const EDITOR_PERMISSIONS = getPermissionsForRoles(['editor']);
const ACTOR = '33333333-3333-3333-3333-333333333333';
const REQUEST_ID = '44444444-4444-4444-4444-444444444444';
const AUTH_ID = '55555555-5555-5555-5555-555555555555';

const VALID_INPUT = {
  fullName: '  Synthetic Reviewer  ',
  email: '  Synthetic.Reviewer@Capstone.TEST ',
  roles: ['reviewer'],
};

function gateways(overrides: {
  reserve?: unknown;
  bind?: unknown;
  finalize?: unknown;
  invite?: string | null;
  deleteOk?: boolean;
  failThrows?: boolean;
  boundAuthUserId?: string | null;
} = {}) {
  const reserve = vi.fn().mockResolvedValue(
    overrides.reserve ?? {
      resultCode: 'RESERVED',
      requestId: REQUEST_ID,
      normalizedEmail: 'synthetic.reviewer@capstone.test',
      fullName: 'Synthetic Reviewer',
      roles: ['reviewer'],
      authUserId: null,
      authIdentityCreated: false,
    },
  );
  const bind = vi.fn().mockResolvedValue(
    overrides.bind ?? { resultCode: 'BOUND', authUserId: AUTH_ID, authIdentityCreated: true },
  );
  const finalize = vi.fn().mockResolvedValue(
    overrides.finalize ?? { resultCode: 'SUCCESS', adminUserId: 'admin-1', status: 'pending_activation' },
  );
  const fail = vi.fn().mockImplementation(async () => {
    if (overrides.failThrows) throw new Error('evidence write failed');
  });
  const readBoundAuthUserId = vi.fn().mockResolvedValue(overrides.boundAuthUserId ?? null);
  const invite = vi.fn().mockResolvedValue(overrides.invite === undefined ? AUTH_ID : overrides.invite);
  const deleteAuthIdentity = vi.fn().mockResolvedValue(overrides.deleteOk ?? true);

  return {
    provisioning: { reserve, bind, finalize, fail, readBoundAuthUserId },
    invitations: { invite, deleteAuthIdentity },
  };
}

function context(
  parts: ReturnType<typeof gateways>,
  options: { permissions?: string[]; enabled?: boolean } = {},
): StaffProvisioningRequestContext {
  return {
    permissions: (options.permissions ?? ADMIN_PERMISSIONS) as StaffProvisioningRequestContext['permissions'],
    actorAdminUserId: ACTOR,
    provisioningEnabled: options.enabled ?? true,
    provisioning: parts.provisioning,
    invitations: parts.invitations,
  };
}

describe('provisionStaffMember', () => {
  it('issues an invitation and leaves the identity pending activation', async () => {
    const parts = gateways();
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('INVITATION_PENDING');
    expect(outcome.invitation).toEqual({
      fullName: 'Synthetic Reviewer',
      email: 'synthetic.reviewer@capstone.test',
      roles: ['reviewer'],
    });
    expect(parts.provisioning.reserve).toHaveBeenCalledWith({
      actorAdminUserId: ACTOR,
      email: 'synthetic.reviewer@capstone.test',
      fullName: 'Synthetic Reviewer',
      roles: ['reviewer'],
    });
    expect(parts.invitations.deleteAuthIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['reviewer', REVIEWER_PERMISSIONS],
    ['editor', EDITOR_PERMISSIONS],
    ['editor+reviewer', getPermissionsForRoles(['editor', 'reviewer'])],
  ])('denies %s before any side effect', async (_label, permissions) => {
    const parts = gateways();
    const outcome = await provisionStaffMember(context(parts, { permissions }), VALID_INPUT);

    expect(outcome.code).toBe('PERMISSION_DENIED');
    expect(parts.provisioning.reserve).not.toHaveBeenCalled();
    expect(parts.invitations.invite).not.toHaveBeenCalled();
  });

  it('fails closed when provisioning is not enabled', async () => {
    const parts = gateways();
    const outcome = await provisionStaffMember(context(parts, { enabled: false }), VALID_INPUT);

    expect(outcome.code).toBe('PROVISIONING_DISABLED');
    expect(parts.provisioning.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed email', { ...VALID_INPUT, email: 'not-an-email' }],
    ['blank name', { ...VALID_INPUT, fullName: '   ' }],
    ['empty roles', { ...VALID_INPUT, roles: [] }],
    ['unknown role', { ...VALID_INPUT, roles: ['superuser'] }],
    ['non-object payload', 'invitation'],
  ])('rejects %s before Auth or database side effects', async (_label, input) => {
    const parts = gateways();
    const outcome = await provisionStaffMember(context(parts), input);

    expect(outcome.code).toBe('VALIDATION_FAILED');
    expect(parts.provisioning.reserve).not.toHaveBeenCalled();
    expect(parts.invitations.invite).not.toHaveBeenCalled();
  });

  it('ignores browser-supplied actor, authority and status fields', async () => {
    const parts = gateways();
    await provisionStaffMember(context(parts), {
      ...VALID_INPUT,
      actorAdminUserId: 'attacker-admin',
      authUserId: 'attacker-auth',
      permissions: ['staff.manage'],
      status: 'activated',
      requestId: 'attacker-request',
    });

    expect(parts.provisioning.reserve).toHaveBeenCalledWith({
      actorAdminUserId: ACTOR,
      email: 'synthetic.reviewer@capstone.test',
      fullName: 'Synthetic Reviewer',
      roles: ['reviewer'],
    });
  });

  it('reports an outstanding invitation without re-inviting', async () => {
    const parts = gateways({ reserve: { resultCode: 'ALREADY_INVITED' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('ALREADY_INVITED');
    expect(parts.invitations.invite).not.toHaveBeenCalled();
  });

  it('reports an existing staff account without re-inviting', async () => {
    const parts = gateways({ reserve: { resultCode: 'ALREADY_PROVISIONED' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('ALREADY_PROVISIONED');
    expect(parts.invitations.invite).not.toHaveBeenCalled();
  });

  it('resumes a partially completed attempt without creating a second Auth identity', async () => {
    const parts = gateways({
      reserve: {
        resultCode: 'RESUMED',
        requestId: REQUEST_ID,
        normalizedEmail: 'synthetic.reviewer@capstone.test',
        fullName: 'Synthetic Reviewer',
        roles: ['reviewer'],
        authUserId: AUTH_ID,
        authIdentityCreated: true,
      },
      bind: { resultCode: 'BOUND', authUserId: AUTH_ID, authIdentityCreated: true },
    });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('INVITATION_PENDING');
    expect(parts.invitations.invite).not.toHaveBeenCalled();
    expect(parts.provisioning.bind).toHaveBeenCalledWith(REQUEST_ID, AUTH_ID);
  });

  it('never records failure against a lifecycle another attempt owns', async () => {
    const parts = gateways({
      reserve: {
        resultCode: 'RESUMED',
        requestId: REQUEST_ID,
        normalizedEmail: 'synthetic.reviewer@capstone.test',
        fullName: 'Synthetic Reviewer',
        roles: ['reviewer'],
        authUserId: null,
        authIdentityCreated: false,
      },
      invite: null,
      boundAuthUserId: null,
    });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('ALREADY_INVITED');
    expect(parts.provisioning.fail).not.toHaveBeenCalled();
  });

  it('releases its own Auth identity but leaves another attempt lifecycle intact', async () => {
    const parts = gateways({
      reserve: {
        resultCode: 'RESUMED',
        requestId: REQUEST_ID,
        normalizedEmail: 'synthetic.reviewer@capstone.test',
        fullName: 'Synthetic Reviewer',
        roles: ['reviewer'],
        authUserId: null,
        authIdentityCreated: false,
      },
      finalize: { resultCode: 'INVALID_STATE' },
    });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('ALREADY_INVITED');
    expect(parts.invitations.deleteAuthIdentity).toHaveBeenCalledWith(AUTH_ID);
    expect(parts.provisioning.fail).not.toHaveBeenCalled();
  });

  it('preserves the originally reserved values when resuming with different input', async () => {
    const parts = gateways({
      reserve: {
        resultCode: 'RESUMED',
        requestId: REQUEST_ID,
        normalizedEmail: 'synthetic.reviewer@capstone.test',
        fullName: 'Original Name',
        roles: ['editor'],
        authUserId: AUTH_ID,
        authIdentityCreated: true,
      },
    });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.invitation).toEqual({
      fullName: 'Original Name',
      email: 'synthetic.reviewer@capstone.test',
      roles: ['editor'],
    });
  });

  it('converges on the authoritative identity when a concurrent attempt already created it', async () => {
    const parts = gateways({ invite: null, boundAuthUserId: AUTH_ID });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('INVITATION_PENDING');
    expect(parts.provisioning.bind).toHaveBeenCalledWith(REQUEST_ID, AUTH_ID);
    expect(parts.invitations.deleteAuthIdentity).not.toHaveBeenCalled();
  });

  it('records a failed invitation without compensating an identity it never created', async () => {
    const parts = gateways({ invite: null, boundAuthUserId: null });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('INVITATION_FAILED');
    expect(parts.invitations.deleteAuthIdentity).not.toHaveBeenCalled();
    expect(parts.provisioning.fail).toHaveBeenCalledWith(REQUEST_ID, 'INVITATION_FAILED', 'not_required');
  });

  it('compensates the Auth identity it created when finalization fails', async () => {
    const parts = gateways({ finalize: { resultCode: 'INVALID_STATE' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('PROVISIONING_FAILED');
    expect(parts.invitations.deleteAuthIdentity).toHaveBeenCalledWith(AUTH_ID);
    expect(parts.provisioning.fail).toHaveBeenCalledWith(REQUEST_ID, 'FINALIZE_REJECTED', 'succeeded');
  });

  it('never deletes an Auth identity this attempt did not create', async () => {
    const parts = gateways({
      bind: { resultCode: 'BOUND', authUserId: AUTH_ID, authIdentityCreated: false },
      finalize: { resultCode: 'INVALID_STATE' },
    });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('PROVISIONING_FAILED');
    expect(parts.invitations.deleteAuthIdentity).not.toHaveBeenCalled();
    expect(parts.provisioning.fail).toHaveBeenCalledWith(REQUEST_ID, 'FINALIZE_REJECTED', 'not_required');
  });

  it('fails closed and records evidence when compensation itself fails', async () => {
    const parts = gateways({ finalize: { resultCode: 'INVALID_STATE' }, deleteOk: false });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('COMPENSATION_FAILED');
    expect(parts.provisioning.fail).toHaveBeenCalledWith(REQUEST_ID, 'FINALIZE_REJECTED', 'failed');
  });

  it('never reports success when failure evidence cannot be persisted', async () => {
    const parts = gateways({ finalize: { resultCode: 'INVALID_STATE' }, failThrows: true });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('COMPENSATION_FAILED');
  });

  it('compensates and reports collision when a staff profile already exists at finalization', async () => {
    const parts = gateways({ finalize: { resultCode: 'ALREADY_PROVISIONED' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('ALREADY_PROVISIONED');
    expect(parts.invitations.deleteAuthIdentity).toHaveBeenCalledWith(AUTH_ID);
  });

  it('yields to the authoritative lifecycle when another attempt already bound the request', async () => {
    const parts = gateways({ bind: { resultCode: 'ALREADY_BOUND', authUserId: 'other-auth-id' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('ALREADY_INVITED');
    expect(parts.invitations.deleteAuthIdentity).toHaveBeenCalledWith(AUTH_ID);
    expect(parts.provisioning.finalize).not.toHaveBeenCalled();
  });

  it('treats a reservation infrastructure failure as a bounded provisioning failure', async () => {
    const parts = gateways();
    parts.provisioning.reserve.mockRejectedValue(new Error('relation does not exist'));
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('PROVISIONING_FAILED');
    expect(outcome.message).not.toContain('relation');
  });
});
