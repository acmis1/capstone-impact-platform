import { describe, expect, it, vi } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { provisionStaffMember, type StaffProvisioningRequestContext } from './staffProvisioningService';

const ADMIN_PERMISSIONS = getPermissionsForRoles(['admin']);
const REVIEWER_PERMISSIONS = getPermissionsForRoles(['reviewer']);
const EDITOR_PERMISSIONS = getPermissionsForRoles(['editor']);
const ACTOR = '33333333-3333-3333-3333-333333333333';
const REQUEST_ID = '44444444-4444-4444-4444-444444444444';
const AUTH_ID = '55555555-5555-5555-5555-555555555555';
const EXECUTION_TOKEN = '66666666-6666-6666-6666-666666666666';
const AUTH_OWNERSHIP_TOKEN = '77777777-7777-7777-7777-777777777777';

const VALID_INPUT = {
  fullName: '  Synthetic Reviewer  ',
  email: '  Synthetic.Reviewer@Capstone.TEST ',
  roles: ['reviewer'],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function gateways(overrides: {
  reserve?: unknown;
  recover?: unknown;
  bind?: unknown;
  finalize?: unknown;
  beginCompensation?: unknown;
  fail?: unknown;
  invite?: string | null;
  deleteOk?: boolean;
} = {}) {
  const reserve = vi.fn().mockResolvedValue(overrides.reserve ?? {
    resultCode: 'RESERVED',
    requestId: REQUEST_ID,
    executionToken: EXECUTION_TOKEN,
    authOwnershipToken: AUTH_OWNERSHIP_TOKEN,
    normalizedEmail: 'synthetic.reviewer@capstone.test',
    fullName: 'Synthetic Reviewer',
    roles: ['reviewer'],
    authUserId: null,
    authIdentityOwned: false,
    status: 'reserved',
  });
  const recoverIdentity = vi.fn().mockResolvedValue(
    overrides.recover ?? { resultCode: 'OWNED_IDENTITY_NOT_FOUND' },
  );
  const bind = vi.fn().mockResolvedValue(
    overrides.bind ?? { resultCode: 'BOUND', authUserId: AUTH_ID, authIdentityOwned: true },
  );
  const finalize = vi.fn().mockResolvedValue(
    overrides.finalize ?? { resultCode: 'SUCCESS', adminUserId: 'admin-1', status: 'pending_activation' },
  );
  const beginCompensation = vi.fn().mockResolvedValue(
    overrides.beginCompensation ?? { resultCode: 'COMPENSATION_AUTHORIZED' },
  );
  const fail = vi.fn().mockResolvedValue(overrides.fail ?? { resultCode: 'FAILED' });
  const invite = vi.fn().mockResolvedValue(overrides.invite === undefined ? AUTH_ID : overrides.invite);
  const deleteAuthIdentity = vi.fn().mockResolvedValue(overrides.deleteOk ?? true);

  return {
    provisioning: { reserve, recoverIdentity, bind, finalize, beginCompensation, fail },
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
  it('uses the server-only credentials for one coherent invitation workflow', async () => {
    const parts = gateways();
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome).toMatchObject({
      code: 'INVITATION_PENDING',
      invitation: {
        fullName: 'Synthetic Reviewer',
        email: 'synthetic.reviewer@capstone.test',
        roles: ['reviewer'],
      },
    });
    expect(parts.invitations.invite).toHaveBeenCalledWith({
      email: 'synthetic.reviewer@capstone.test',
      fullName: 'Synthetic Reviewer',
      requestId: REQUEST_ID,
      authOwnershipToken: AUTH_OWNERSHIP_TOKEN,
    });
    expect(parts.provisioning.bind).toHaveBeenCalledWith(REQUEST_ID, EXECUTION_TOKEN, AUTH_ID);
    expect(parts.provisioning.finalize).toHaveBeenCalledWith(REQUEST_ID, EXECUTION_TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(EXECUTION_TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(AUTH_OWNERSHIP_TOKEN);
  });

  it.each([
    ['reviewer', REVIEWER_PERMISSIONS],
    ['editor', EDITOR_PERMISSIONS],
    ['editor+reviewer', getPermissionsForRoles(['editor', 'reviewer'])],
  ])('denies %s before every side effect', async (_label, permissions) => {
    const parts = gateways();
    const outcome = await provisionStaffMember(context(parts, { permissions }), VALID_INPUT);
    expect(outcome.code).toBe('PERMISSION_DENIED');
    expect(parts.provisioning.reserve).not.toHaveBeenCalled();
    expect(parts.invitations.invite).not.toHaveBeenCalled();
  });

  it('fails closed when provisioning is disabled', async () => {
    const parts = gateways();
    expect((await provisionStaffMember(context(parts, { enabled: false }), VALID_INPUT)).code)
      .toBe('PROVISIONING_DISABLED');
    expect(parts.provisioning.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed email', { ...VALID_INPUT, email: 'not-an-email' }],
    ['blank name', { ...VALID_INPUT, fullName: '   ' }],
    ['empty roles', { ...VALID_INPUT, roles: [] }],
    ['unknown role', { ...VALID_INPUT, roles: ['superuser'] }],
  ])('rejects %s before Auth or database side effects', async (_label, input) => {
    const parts = gateways();
    expect((await provisionStaffMember(context(parts), input)).code).toBe('VALIDATION_FAILED');
    expect(parts.provisioning.reserve).not.toHaveBeenCalled();
    expect(parts.invitations.invite).not.toHaveBeenCalled();
  });

  it('makes an active-lease observer return IN_PROGRESS without inviting or mutating', async () => {
    const parts = gateways({ reserve: { resultCode: 'IN_PROGRESS' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('IN_PROGRESS');
    expect(parts.invitations.invite).not.toHaveBeenCalled();
    expect(parts.provisioning.bind).not.toHaveBeenCalled();
    expect(parts.provisioning.finalize).not.toHaveBeenCalled();
    expect(parts.provisioning.fail).not.toHaveBeenCalled();
    expect(parts.invitations.deleteAuthIdentity).not.toHaveBeenCalled();
  });

  it('forces A-before-invite/B-observer ordering and permits only A to call Auth', async () => {
    const invitation = deferred<string | null>();
    const owner = gateways();
    owner.invitations.invite.mockReturnValueOnce(invitation.promise);
    const observer = gateways({ reserve: { resultCode: 'IN_PROGRESS' } });
    observer.invitations = owner.invitations;

    const ownerRun = provisionStaffMember(context(owner), VALID_INPUT);
    await vi.waitFor(() => expect(owner.invitations.invite).toHaveBeenCalledTimes(1));

    const observerOutcome = await provisionStaffMember(context(observer), VALID_INPUT);
    expect(observerOutcome.code).toBe('IN_PROGRESS');
    expect(owner.invitations.invite).toHaveBeenCalledTimes(1);
    expect(observer.provisioning.fail).not.toHaveBeenCalled();

    invitation.resolve(AUTH_ID);
    expect((await ownerRun).code).toBe('INVITATION_PENDING');
  });

  it('forces A-after-invite/before-bind and still prevents B from inviting or failing', async () => {
    const binding = deferred<{ resultCode: string; authUserId: string; authIdentityOwned: boolean }>();
    const owner = gateways();
    owner.provisioning.bind.mockReturnValueOnce(binding.promise);
    const observer = gateways({ reserve: { resultCode: 'IN_PROGRESS' } });
    observer.invitations = owner.invitations;

    const ownerRun = provisionStaffMember(context(owner), VALID_INPUT);
    await vi.waitFor(() => expect(owner.provisioning.bind).toHaveBeenCalledTimes(1));
    const observerOutcome = await provisionStaffMember(context(observer), VALID_INPUT);

    expect(observerOutcome.code).toBe('IN_PROGRESS');
    expect(owner.invitations.invite).toHaveBeenCalledTimes(1);
    expect(observer.provisioning.fail).not.toHaveBeenCalled();
    binding.resolve({ resultCode: 'BOUND', authUserId: AUTH_ID, authIdentityOwned: true });
    expect((await ownerRun).code).toBe('INVITATION_PENDING');
  });

  it('recovers an abandoned reserved lifecycle and invites only after no owned Auth row is found', async () => {
    const parts = gateways({
      reserve: {
        resultCode: 'RECOVERED', requestId: REQUEST_ID, executionToken: EXECUTION_TOKEN,
        authOwnershipToken: AUTH_OWNERSHIP_TOKEN, normalizedEmail: 'synthetic.reviewer@capstone.test',
        fullName: 'Original Name', roles: ['editor'], status: 'reserved',
      },
    });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('INVITATION_PENDING');
    expect(parts.provisioning.recoverIdentity).toHaveBeenCalledWith(REQUEST_ID, EXECUTION_TOKEN);
    expect(parts.invitations.invite).toHaveBeenCalledTimes(1);
    expect(outcome.invitation).toMatchObject({ fullName: 'Original Name', roles: ['editor'] });
  });

  it('recovers an already-created marked identity without a second invitation', async () => {
    const parts = gateways({
      reserve: {
        resultCode: 'RECOVERED', requestId: REQUEST_ID, executionToken: EXECUTION_TOKEN,
        authOwnershipToken: AUTH_OWNERSHIP_TOKEN, normalizedEmail: 'synthetic.reviewer@capstone.test',
        fullName: 'Synthetic Reviewer', roles: ['reviewer'], status: 'reserved',
      },
      recover: { resultCode: 'OWNED_IDENTITY_BOUND', authUserId: AUTH_ID, authIdentityOwned: true },
    });
    expect((await provisionStaffMember(context(parts), VALID_INPUT)).code).toBe('INVITATION_PENDING');
    expect(parts.invitations.invite).not.toHaveBeenCalled();
  });

  it('converges on a marked identity after a lost invitation response', async () => {
    const parts = gateways({
      invite: null,
      recover: { resultCode: 'OWNED_IDENTITY_BOUND', authUserId: AUTH_ID, authIdentityOwned: true },
    });
    expect((await provisionStaffMember(context(parts), VALID_INPUT)).code).toBe('INVITATION_PENDING');
    expect(parts.provisioning.fail).not.toHaveBeenCalled();
  });

  it('records invitation failure with the current token and never deletes an unrelated identity', async () => {
    const parts = gateways({ invite: null });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('INVITATION_FAILED');
    expect(parts.invitations.deleteAuthIdentity).not.toHaveBeenCalled();
    expect(parts.provisioning.beginCompensation).not.toHaveBeenCalled();
    expect(parts.provisioning.fail).toHaveBeenCalledWith(
      REQUEST_ID, EXECUTION_TOKEN, 'INVITATION_FAILED', 'not_required',
    );
  });

  it('authorizes destructive compensation before deleting an exact owned identity', async () => {
    const parts = gateways({ finalize: { resultCode: 'INVALID_STATE' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('PROVISIONING_FAILED');
    expect(parts.provisioning.beginCompensation).toHaveBeenCalledWith(
      REQUEST_ID, EXECUTION_TOKEN, AUTH_ID,
    );
    expect(parts.invitations.deleteAuthIdentity).toHaveBeenCalledWith(AUTH_ID);
    expect(parts.provisioning.fail).toHaveBeenCalledWith(
      REQUEST_ID, EXECUTION_TOKEN, 'FINALIZE_REJECTED', 'succeeded',
    );
  });

  it('fails closed without deletion when Auth ownership proof is absent', async () => {
    const parts = gateways({ bind: { resultCode: 'AUTH_OWNERSHIP_MISMATCH' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('PROVISIONING_FAILED');
    expect(parts.provisioning.beginCompensation).not.toHaveBeenCalled();
    expect(parts.invitations.deleteAuthIdentity).not.toHaveBeenCalled();
    expect(parts.provisioning.fail).toHaveBeenCalledWith(
      REQUEST_ID, EXECUTION_TOKEN, 'BIND_REJECTED', 'not_required',
    );
  });

  it('records compensation failure and keeps the identity fail-closed', async () => {
    const parts = gateways({
      finalize: { resultCode: 'INVALID_STATE' },
      deleteOk: false,
      fail: { resultCode: 'COMPENSATION_FAILED' },
    });
    expect((await provisionStaffMember(context(parts), VALID_INPUT)).code).toBe('COMPENSATION_FAILED');
    expect(parts.provisioning.fail).toHaveBeenCalledWith(
      REQUEST_ID, EXECUTION_TOKEN, 'FINALIZE_REJECTED', 'failed',
    );
  });

  it('treats a rotated stale execution token as an observer and cannot fail or compensate', async () => {
    const parts = gateways({ bind: { resultCode: 'EXECUTION_TOKEN_MISMATCH' } });
    const outcome = await provisionStaffMember(context(parts), VALID_INPUT);

    expect(outcome.code).toBe('IN_PROGRESS');
    expect(parts.provisioning.beginCompensation).not.toHaveBeenCalled();
    expect(parts.provisioning.fail).not.toHaveBeenCalled();
    expect(parts.invitations.deleteAuthIdentity).not.toHaveBeenCalled();
  });

  it('never reports success when failure evidence cannot be persisted', async () => {
    const parts = gateways({ invite: null });
    parts.provisioning.fail.mockRejectedValueOnce(new Error('evidence write failed'));
    expect((await provisionStaffMember(context(parts), VALID_INPUT)).code).toBe('COMPENSATION_FAILED');
  });
});
