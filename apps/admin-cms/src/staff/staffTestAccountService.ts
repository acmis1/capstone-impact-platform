import type { AdminPermission, AdminRole } from '../auth/authTypes';
import { canManageStaff } from '../auth/permissions';
import type {
  FinalizeOutcome,
  IdentityOutcome,
  ReservationOutcome,
  StaffInvitationGateway,
  StaffProvisioningGateway,
  TransitionOutcome,
} from './staffProvisioningService';
import { provisionStaffMember } from './staffProvisioningService';
import {
  staffTestAccountMessage,
  type StaffTestAccountResult,
  type StaffTestAccountResultCode,
  type StaffTestAccountRole,
  validateStaffTestAccountInput,
} from './staffTestAccount';

export interface StaffDirectProvisioningGateway extends StaffProvisioningGateway {
  finalizeAndActivate(requestId: string, executionToken: string): Promise<FinalizeOutcome>;
}

export interface StaffPasswordIdentityGateway {
  createPasswordIdentity(input: {
    email: string;
    fullName: string;
    password: string;
    requestId: string;
    authOwnershipToken: string;
  }): Promise<string | null>;
  deleteAuthIdentity(authUserId: string): Promise<boolean>;
}

export interface StaffTestAccountRequestContext {
  permissions: AdminPermission[];
  actorAdminUserId: string;
  provisioningEnabled: boolean;
  stagingRuntimeVerified: boolean;
  provisioning: StaffDirectProvisioningGateway;
  identities: StaffPasswordIdentityGateway;
}

function result(code: StaffTestAccountResultCode): StaffTestAccountResult {
  return { code, message: staffTestAccountMessage(code) };
}

function directRolesOnly(roles: string[] | null | undefined): roles is StaffTestAccountRole[] {
  return (
    Array.isArray(roles)
    && roles.length > 0
    && roles.every((role) => role === 'reviewer' || role === 'editor')
  );
}

/**
 * Creates and activates a staging-only password identity through the existing fenced lifecycle.
 * The password exists only in this call stack and is passed once to the server-only Auth gateway.
 */
export async function provisionStaffTestAccount(
  context: StaffTestAccountRequestContext,
  rawInput: unknown,
): Promise<StaffTestAccountResult> {
  if (!canManageStaff(context.permissions)) return result('PERMISSION_DENIED');
  if (!context.stagingRuntimeVerified) return result('STAGING_ONLY');
  if (!context.provisioningEnabled) return result('PROVISIONING_DISABLED');

  const validation = validateStaffTestAccountInput(rawInput);
  if (!validation.valid) return result('VALIDATION_FAILED');
  const { fullName, email, password, roles } = validation.data;

  // Reuse the mature ownership/recovery/compensation engine. This adapter prevents a direct
  // request from recovering any older lifecycle whose durable role set contains Administrator.
  const directProvisioning: StaffProvisioningGateway = {
    reserve: async (input: {
      actorAdminUserId: string;
      email: string;
      fullName: string;
      roles: AdminRole[];
    }): Promise<ReservationOutcome> => {
      const reservation = await context.provisioning.reserve(input);
      if (
        ['RESERVED', 'RECOVERED', 'RECOVERED_COMPENSATION'].includes(reservation.resultCode)
        && !directRolesOnly(reservation.roles)
      ) {
        return { resultCode: 'VALIDATION_FAILED' };
      }
      return reservation;
    },
    recoverIdentity: (requestId: string, executionToken: string): Promise<IdentityOutcome> =>
      context.provisioning.recoverIdentity(requestId, executionToken),
    bind: (requestId: string, executionToken: string, authUserId: string): Promise<IdentityOutcome> =>
      context.provisioning.bind(requestId, executionToken, authUserId),
    finalize: (requestId: string, executionToken: string): Promise<FinalizeOutcome> =>
      context.provisioning.finalizeAndActivate(requestId, executionToken),
    beginCompensation: (
      requestId: string,
      executionToken: string,
      authUserId: string,
    ): Promise<TransitionOutcome> =>
      context.provisioning.beginCompensation(requestId, executionToken, authUserId),
    fail: (
      requestId: string,
      executionToken: string,
      failureCode: string,
      compensationState: 'not_required' | 'succeeded' | 'failed',
    ): Promise<TransitionOutcome> =>
      context.provisioning.fail(requestId, executionToken, failureCode, compensationState),
  };

  const identityAdapter: StaffInvitationGateway = {
    invite: (input) =>
      context.identities.createPasswordIdentity({ ...input, password }),
    deleteAuthIdentity: (authUserId) => context.identities.deleteAuthIdentity(authUserId),
  };

  const outcome = await provisionStaffMember(
    {
      permissions: context.permissions,
      actorAdminUserId: context.actorAdminUserId,
      provisioningEnabled: true,
      provisioning: directProvisioning,
      invitations: identityAdapter,
      identityCreationFailureCode: 'ACCOUNT_CREATION_FAILED',
    },
    { fullName, email, roles },
  );

  if (outcome.code === 'INVITATION_PENDING') return result('ACCOUNT_READY');
  if (outcome.code === 'INVITATION_FAILED') return result('ACCOUNT_CREATION_FAILED');
  return result(outcome.code as StaffTestAccountResultCode);
}
