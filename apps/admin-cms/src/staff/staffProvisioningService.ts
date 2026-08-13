import type { AdminPermission, AdminRole } from '../auth/authTypes';
import { canManageStaff } from '../auth/permissions';
import {
  type StaffProvisioningResultCode,
  staffProvisioningMessage,
  validateStaffInvitationInput,
} from './staffProvisioning';

/** Outcome of reserving the normalized target identity, before Auth is touched. */
export interface ReservationOutcome {
  resultCode: string;
  requestId?: string | null;
  normalizedEmail?: string | null;
  fullName?: string | null;
  roles?: string[] | null;
  authUserId?: string | null;
  authIdentityCreated?: boolean | null;
}

export interface BindOutcome {
  resultCode: string;
  authUserId?: string | null;
  authIdentityCreated?: boolean | null;
}

export interface FinalizeOutcome {
  resultCode: string;
  adminUserId?: string | null;
  status?: string | null;
}

/** Durable state transitions. Every method is service-role only behind the caller. */
export interface StaffProvisioningGateway {
  reserve(input: {
    actorAdminUserId: string;
    email: string;
    fullName: string;
    roles: AdminRole[];
  }): Promise<ReservationOutcome>;
  bind(requestId: string, authUserId: string): Promise<BindOutcome>;
  finalize(requestId: string): Promise<FinalizeOutcome>;
  fail(
    requestId: string,
    failureCode: string,
    compensationState: 'not_required' | 'succeeded' | 'failed',
  ): Promise<void>;
  /** Re-reads the durable binding so a losing concurrent attempt can converge instead of duplicating. */
  readBoundAuthUserId(requestId: string): Promise<string | null>;
}

/** The Supabase Auth administrative invitation boundary. */
export interface StaffInvitationGateway {
  /** Returns the created/invited Auth identity, or null when the invitation could not be sent. */
  invite(input: { email: string; fullName: string }): Promise<string | null>;
  /** Returns true only when the Auth identity was actually removed. */
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
  /** Normalized echo of what was actually reserved — never the caller's raw input. */
  invitation?: { fullName: string; email: string; roles: AdminRole[] };
}

function result(
  code: StaffProvisioningResultCode,
  invitation?: StaffProvisioningResult['invitation'],
): StaffProvisioningResult {
  return { code, message: staffProvisioningMessage(code), invitation };
}

/**
 * Executes the full staff provisioning workflow across Supabase Auth and PostgreSQL.
 *
 * Auth and PostgreSQL are not one transaction, so the workflow is an explicit convergence
 * sequence: reserve the normalized identity durably, invite, bind the exact returned Auth
 * identity to that reservation, then finalize the staff profile and roles into a deliberately
 * unusable 'pending_activation' state. Every failure after the Auth identity was created by
 * THIS attempt is compensated; a compensation that cannot complete is recorded and fails closed.
 *
 * The caller's authority, actor identity and permissions arrive from the authenticated server
 * session only — nothing here reads an actor, status or target identity from a browser payload.
 */
export async function provisionStaffMember(
  context: StaffProvisioningRequestContext,
  rawInput: unknown,
): Promise<StaffProvisioningResult> {
  if (!canManageStaff(context.permissions)) {
    return result('PERMISSION_DENIED');
  }
  if (!context.provisioningEnabled) {
    return result('PROVISIONING_DISABLED');
  }

  const validation = validateStaffInvitationInput(rawInput);
  if (!validation.valid) {
    return result('VALIDATION_FAILED');
  }
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
    case 'ALREADY_INVITED':
      return result('ALREADY_INVITED');
    case 'ALREADY_PROVISIONED':
      return result('ALREADY_PROVISIONED');
    case 'RESERVED':
    case 'RESUMED':
      break;
    default:
      return result('PROVISIONING_FAILED');
  }

  const requestId = reservation.requestId;
  if (!requestId) {
    return result('PROVISIONING_FAILED');
  }

  // Only the attempt that actually created the reservation owns the lifecycle. A resumed attempt
  // has joined a lifecycle another attempt may still be driving, so it must never record failure
  // against it — doing so would let a losing concurrent request destroy the winner's state.
  const ownsLifecycle = reservation.resultCode === 'RESERVED';

  // The durable record is authoritative for what was reserved, so a resumed attempt can never
  // silently rewrite the pending request's name or roles.
  const reserved = {
    fullName: reservation.fullName ?? fullName,
    email: reservation.normalizedEmail ?? email,
    roles: (reservation.roles ?? roles) as AdminRole[],
  };

  /**
   * Compensating rollback. An Auth identity is deleted only when the database proved this exact
   * attempt created it, so pre-existing Auth users and unrelated accounts are never touched.
   */
  const compensate = async (
    failureCode: string,
    intended: StaffProvisioningResultCode,
    authUserId: string | null,
    authIdentityCreated: boolean,
  ): Promise<StaffProvisioningResult> => {
    let compensationState: 'not_required' | 'succeeded' | 'failed' = 'not_required';
    if (authUserId && authIdentityCreated) {
      try {
        compensationState = (await context.invitations.deleteAuthIdentity(authUserId))
          ? 'succeeded'
          : 'failed';
      } catch {
        compensationState = 'failed';
      }
    }

    if (!ownsLifecycle) {
      // The reservation belongs to another attempt. Anything this attempt created has been
      // released above; the authoritative lifecycle is left exactly as its owner left it.
      return result('ALREADY_INVITED', reserved);
    }

    try {
      await context.provisioning.fail(requestId, failureCode, compensationState);
    } catch {
      // Evidence could not be persisted; never downgrade to a success-shaped result.
      return result('COMPENSATION_FAILED', reserved);
    }

    return result(compensationState === 'failed' ? 'COMPENSATION_FAILED' : intended, reserved);
  };

  let authUserId = reservation.authUserId ?? null;
  let authIdentityCreated = reservation.authIdentityCreated === true;

  if (!authUserId) {
    let invited: string | null = null;
    try {
      invited = await context.invitations.invite({ email: reserved.email, fullName: reserved.fullName });
    } catch {
      invited = null;
    }

    if (!invited) {
      // A concurrent attempt for the same normalized identity may already have created and bound
      // the authoritative Auth identity, which is exactly why this invitation was refused.
      let converged: string | null = null;
      try {
        converged = await context.provisioning.readBoundAuthUserId(requestId);
      } catch {
        converged = null;
      }
      if (!converged) {
        return compensate('INVITATION_FAILED', 'INVITATION_FAILED', null, false);
      }
      authUserId = converged;
    } else {
      authUserId = invited;
    }
  }

  let bind: BindOutcome;
  try {
    bind = await context.provisioning.bind(requestId, authUserId);
  } catch {
    return compensate('BIND_FAILED', 'PROVISIONING_FAILED', authUserId, authIdentityCreated);
  }

  if (bind.resultCode === 'ALREADY_BOUND') {
    // Another attempt owns this lifecycle. Remove the identity this attempt created, then
    // converge onto the authoritative one rather than competing with it.
    if (authUserId && bind.authUserId && bind.authUserId !== authUserId) {
      try {
        await context.invitations.deleteAuthIdentity(authUserId);
      } catch {
        // The authoritative lifecycle is unaffected; surface the pending invitation below.
      }
    }
    return result('ALREADY_INVITED', reserved);
  }

  if (bind.resultCode !== 'BOUND') {
    return compensate('BIND_REJECTED', 'PROVISIONING_FAILED', authUserId, authIdentityCreated);
  }

  authUserId = bind.authUserId ?? authUserId;
  authIdentityCreated = bind.authIdentityCreated === true;

  let finalize: FinalizeOutcome;
  try {
    finalize = await context.provisioning.finalize(requestId);
  } catch {
    return compensate('FINALIZE_FAILED', 'PROVISIONING_FAILED', authUserId, authIdentityCreated);
  }

  if (finalize.resultCode === 'ALREADY_PROVISIONED') {
    return compensate('PROFILE_COLLISION', 'ALREADY_PROVISIONED', authUserId, authIdentityCreated);
  }
  if (finalize.resultCode !== 'SUCCESS') {
    return compensate('FINALIZE_REJECTED', 'PROVISIONING_FAILED', authUserId, authIdentityCreated);
  }

  return result('INVITATION_PENDING', reserved);
}
