import type { AdminPermission, AdminRole } from '../auth/authTypes';
import { canManageStaff } from '../auth/permissions';
import {
  type StaffProvisioningResultCode,
  staffProvisioningMessage,
  validateStaffInvitationInput,
} from './staffProvisioning';

/** Internal reservation evidence. Raw credentials never cross the service boundary. */
export interface ReservationOutcome {
  resultCode: string;
  requestId?: string | null;
  executionToken?: string | null;
  authOwnershipToken?: string | null;
  normalizedEmail?: string | null;
  fullName?: string | null;
  roles?: string[] | null;
  authUserId?: string | null;
  authIdentityOwned?: boolean | null;
  status?: string | null;
}

export interface IdentityOutcome {
  resultCode: string;
  authUserId?: string | null;
  authIdentityOwned?: boolean | null;
}

export interface FinalizeOutcome {
  resultCode: string;
  adminUserId?: string | null;
  status?: string | null;
}

export interface TransitionOutcome {
  resultCode: string;
}

/** Durable state transitions. Every mutation requires the current server-only execution token. */
export interface StaffProvisioningGateway {
  reserve(input: {
    actorAdminUserId: string;
    email: string;
    fullName: string;
    roles: AdminRole[];
  }): Promise<ReservationOutcome>;
  recoverIdentity(requestId: string, executionToken: string): Promise<IdentityOutcome>;
  bind(requestId: string, executionToken: string, authUserId: string): Promise<IdentityOutcome>;
  finalize(requestId: string, executionToken: string): Promise<FinalizeOutcome>;
  beginCompensation(
    requestId: string,
    executionToken: string,
    authUserId: string,
  ): Promise<TransitionOutcome>;
  fail(
    requestId: string,
    executionToken: string,
    failureCode: string,
    compensationState: 'not_required' | 'succeeded' | 'failed',
  ): Promise<TransitionOutcome>;
}

/** The Supabase Auth administrative invitation boundary. */
export interface StaffInvitationGateway {
  /** Returns only an identity carrying this lifecycle's server-controlled Auth marker. */
  invite(input: {
    email: string;
    fullName: string;
    requestId: string;
    authOwnershipToken: string;
  }): Promise<string | null>;
  deleteAuthIdentity(authUserId: string): Promise<boolean>;
}

export interface StaffProvisioningRequestContext {
  permissions: AdminPermission[];
  actorAdminUserId: string;
  provisioningEnabled: boolean;
  provisioning: StaffProvisioningGateway;
  invitations: StaffInvitationGateway;
}

export interface StaffProvisioningResult {
  code: StaffProvisioningResultCode;
  message: string;
  /** Normalized echo of what was actually reserved; no internal identifier or token is exposed. */
  invitation?: { fullName: string; email: string; roles: AdminRole[] };
}

function result(
  code: StaffProvisioningResultCode,
  invitation?: StaffProvisioningResult['invitation'],
): StaffProvisioningResult {
  return { code, message: staffProvisioningMessage(code), invitation };
}

function lostExecutionOwnership(code: string): boolean {
  return code === 'EXECUTION_TOKEN_MISMATCH' || code === 'EXECUTION_LEASE_EXPIRED';
}

/**
 * Executes the fenced workflow across Supabase Auth and PostgreSQL.
 *
 * RESERVED, RECOVERED and RECOVERED_COMPENSATION are execution-capable reservation results. IN_PROGRESS is an
 * observer result and returns before Auth is touched. Every bind/finalize/fail/compensation call
 * carries the current execution token; recovery rotates its hash so a former owner is fenced.
 */
export async function provisionStaffMember(
  context: StaffProvisioningRequestContext,
  rawInput: unknown,
): Promise<StaffProvisioningResult> {
  if (!canManageStaff(context.permissions)) return result('PERMISSION_DENIED');
  if (!context.provisioningEnabled) return result('PROVISIONING_DISABLED');

  const validation = validateStaffInvitationInput(rawInput);
  if (!validation.valid) return result('VALIDATION_FAILED');
  const { fullName, email, roles } = validation.data;

  let reservation: ReservationOutcome;
  try {
    reservation = await context.provisioning.reserve({
      actorAdminUserId: context.actorAdminUserId,
      email,
      fullName,
      roles,
    });
  } catch {
    return result('PROVISIONING_FAILED');
  }

  switch (reservation.resultCode) {
    case 'PERMISSION_DENIED':
      return result('PERMISSION_DENIED');
    case 'VALIDATION_FAILED':
      return result('VALIDATION_FAILED');
    case 'IN_PROGRESS':
      return result('IN_PROGRESS');
    case 'ALREADY_INVITED':
      return result('ALREADY_INVITED');
    case 'ALREADY_PROVISIONED':
      return result('ALREADY_PROVISIONED');
    case 'RESERVED':
    case 'RECOVERED':
    case 'RECOVERED_COMPENSATION':
      break;
    default:
      return result('PROVISIONING_FAILED');
  }

  const requestId = reservation.requestId;
  const executionToken = reservation.executionToken;
  const authOwnershipToken = reservation.authOwnershipToken;
  if (!requestId || !executionToken || (reservation.resultCode !== 'RECOVERED_COMPENSATION' && !authOwnershipToken)) {
    return result('PROVISIONING_FAILED');
  }

  const reserved = {
    fullName: reservation.fullName ?? fullName,
    email: reservation.normalizedEmail ?? email,
    roles: (reservation.roles ?? roles) as AdminRole[],
  };

  const recoverIdentity = async (): Promise<IdentityOutcome | null> => {
    try {
      return await context.provisioning.recoverIdentity(requestId, executionToken);
    } catch {
      return null;
    }
  };

  const recordCompensation = async (
    failureCode: string,
    compensationState: 'succeeded' | 'failed',
  ): Promise<StaffProvisioningResult> => {
    let failure: TransitionOutcome;
    try {
      failure = await context.provisioning.fail(requestId, executionToken, failureCode, compensationState);
    } catch {
      return result('COMPENSATION_FAILED', reserved);
    }
    if (lostExecutionOwnership(failure.resultCode)) return result('IN_PROGRESS', reserved);
    if (!['FAILED', 'COMPENSATION_FAILED'].includes(failure.resultCode)) {
      return result('COMPENSATION_FAILED', reserved);
    }
    return result(compensationState === 'failed' ? 'COMPENSATION_FAILED' : 'PROVISIONING_FAILED', reserved);
  };

  // An expired compensating lease is strictly a cleanup reconciliation: it never reaches invite,
  // bind or finalize. The SQL function rechecks exact marker ownership before deletion.
  if (reservation.resultCode === 'RECOVERED_COMPENSATION') {
    const authUserId = reservation.authUserId;
    if (!authUserId || reservation.authIdentityOwned !== true) {
      return recordCompensation('COMPENSATION_RECOVERY_INVALID', 'failed');
    }
    let authorization: TransitionOutcome;
    try {
      authorization = await context.provisioning.beginCompensation(requestId, executionToken, authUserId);
    } catch {
      return result('COMPENSATION_FAILED', reserved);
    }
    if (lostExecutionOwnership(authorization.resultCode)) return result('IN_PROGRESS', reserved);
    if (authorization.resultCode === 'COMPENSATION_ALREADY_COMPLETE') {
      return recordCompensation('COMPENSATION_RECOVERED', 'succeeded');
    }
    if (authorization.resultCode !== 'COMPENSATION_AUTHORIZED') {
      return recordCompensation('COMPENSATION_MARKER_MISMATCH', 'failed');
    }
    let deleted = false;
    try { deleted = await context.invitations.deleteAuthIdentity(authUserId); } catch { /* fail closed below */ }
    return recordCompensation('COMPENSATION_RECOVERED', deleted ? 'succeeded' : 'failed');
  }

  if (!authOwnershipToken) return result('PROVISIONING_FAILED');

  const compensate = async (
    failureCode: string,
    intended: StaffProvisioningResultCode,
    authUserId: string | null,
    authIdentityOwned: boolean,
  ): Promise<StaffProvisioningResult> => {
    let compensationState: 'not_required' | 'succeeded' | 'failed' = 'not_required';

    if (authUserId && authIdentityOwned) {
      let authorization: TransitionOutcome;
      try {
        authorization = await context.provisioning.beginCompensation(
          requestId,
          executionToken,
          authUserId,
        );
      } catch {
        return result('COMPENSATION_FAILED', reserved);
      }
      if (lostExecutionOwnership(authorization.resultCode)) {
        return result('IN_PROGRESS', reserved);
      }
      if (authorization.resultCode !== 'COMPENSATION_AUTHORIZED') {
        return result('COMPENSATION_FAILED', reserved);
      }

      try {
        compensationState = (await context.invitations.deleteAuthIdentity(authUserId))
          ? 'succeeded'
          : 'failed';
      } catch {
        compensationState = 'failed';
      }
    }

    let failure: TransitionOutcome;
    try {
      failure = await context.provisioning.fail(
        requestId,
        executionToken,
        failureCode,
        compensationState,
      );
    } catch {
      return result('COMPENSATION_FAILED', reserved);
    }
    if (lostExecutionOwnership(failure.resultCode)) return result('IN_PROGRESS', reserved);
    if (!['FAILED', 'COMPENSATION_FAILED'].includes(failure.resultCode)) {
      return result('COMPENSATION_FAILED', reserved);
    }

    return result(compensationState === 'failed' ? 'COMPENSATION_FAILED' : intended, reserved);
  };

  let authUserId = reservation.authUserId ?? null;
  let authIdentityOwned = reservation.authIdentityOwned === true;

  // A recovered reserved owner first checks for an Auth insert that the former owner completed
  // but did not bind. The app-metadata marker makes this deterministic and avoids a second invite.
  if (!authUserId && reservation.resultCode === 'RECOVERED') {
    const recovered = await recoverIdentity();
    if (recovered && lostExecutionOwnership(recovered.resultCode)) {
      return result('IN_PROGRESS', reserved);
    }
    if (recovered?.resultCode === 'OWNED_IDENTITY_BOUND' && recovered.authUserId) {
      authUserId = recovered.authUserId;
      authIdentityOwned = recovered.authIdentityOwned === true;
    } else if (recovered && recovered.resultCode !== 'OWNED_IDENTITY_NOT_FOUND') {
      return result('PROVISIONING_FAILED', reserved);
    }
  }

  if (!authUserId) {
    let invited: string | null = null;
    try {
      invited = await context.invitations.invite({
        email: reserved.email,
        fullName: reserved.fullName,
        requestId,
        authOwnershipToken,
      });
    } catch {
      invited = null;
    }

    if (!invited) {
      // A lost provider response may still have committed the exact marked Auth row. Read only
      // that durable ownership proof; no polling or timing race is involved.
      const recovered = await recoverIdentity();
      if (recovered && lostExecutionOwnership(recovered.resultCode)) {
        return result('IN_PROGRESS', reserved);
      }
      if (recovered?.resultCode === 'OWNED_IDENTITY_BOUND' && recovered.authUserId) {
        authUserId = recovered.authUserId;
        authIdentityOwned = recovered.authIdentityOwned === true;
      } else {
        return compensate('INVITATION_FAILED', 'INVITATION_FAILED', null, false);
      }
    } else {
      authUserId = invited;
    }
  }

  let bind: IdentityOutcome;
  try {
    bind = await context.provisioning.bind(requestId, executionToken, authUserId);
  } catch {
    return result('COMPENSATION_FAILED', reserved);
  }
  if (lostExecutionOwnership(bind.resultCode)) return result('IN_PROGRESS', reserved);
  if (bind.resultCode !== 'BOUND') {
    return compensate('BIND_REJECTED', 'PROVISIONING_FAILED', authUserId, false);
  }

  authUserId = bind.authUserId ?? authUserId;
  authIdentityOwned = bind.authIdentityOwned === true;
  if (!authIdentityOwned) {
    return compensate('AUTH_OWNERSHIP_MISMATCH', 'PROVISIONING_FAILED', authUserId, false);
  }

  let finalize: FinalizeOutcome;
  try {
    finalize = await context.provisioning.finalize(requestId, executionToken);
  } catch {
    return compensate('FINALIZE_FAILED', 'PROVISIONING_FAILED', authUserId, authIdentityOwned);
  }
  if (lostExecutionOwnership(finalize.resultCode)) return result('IN_PROGRESS', reserved);
  if (finalize.resultCode === 'ALREADY_PROVISIONED') {
    return compensate('PROFILE_COLLISION', 'ALREADY_PROVISIONED', authUserId, authIdentityOwned);
  }
  if (finalize.resultCode !== 'SUCCESS') {
    return compensate('FINALIZE_REJECTED', 'PROVISIONING_FAILED', authUserId, authIdentityOwned);
  }

  return result('INVITATION_PENDING', reserved);
}
