import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminRole } from '../auth/authTypes';
import type {
  FinalizeOutcome,
  IdentityOutcome,
  ReservationOutcome,
  StaffInvitationGateway,
  StaffProvisioningGateway,
  TransitionOutcome,
} from './staffProvisioningService';
import type { StaffPasswordIdentityGateway } from './staffTestAccountService';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Service-role gateway over the Migration 0022 provisioning state machine.
 *
 * Every privileged transition is a SECURITY DEFINER RPC; this class only forwards
 * server-derived values and normalizes the bounded jsonb result. Raw PostgREST errors are
 * deliberately converted into thrown control flow rather than being returned to a caller.
 */
export class SupabaseStaffProvisioningGateway implements StaffProvisioningGateway {
  constructor(private readonly client: SupabaseClient) {}

  async reserve(input: {
    actorAdminUserId: string;
    email: string;
    fullName: string;
    roles: AdminRole[];
  }): Promise<ReservationOutcome> {
    const { data, error } = await this.client.rpc('reserve_staff_provisioning', {
      p_actor_admin_id: input.actorAdminUserId,
      p_email: input.email,
      p_full_name: input.fullName,
      p_roles: input.roles,
    });
    if (error) throw new Error('STAFF_PROVISIONING_RESERVE_FAILED');

    const payload = asRecord(data);
    const roles = Array.isArray(payload.roles)
      ? payload.roles.filter((role): role is string => typeof role === 'string')
      : null;

    return {
      resultCode: String(payload.resultCode ?? ''),
      requestId: asText(payload.requestId),
      normalizedEmail: asText(payload.normalizedEmail),
      fullName: asText(payload.fullName),
      roles,
      authUserId: asText(payload.authUserId),
      authIdentityOwned: payload.authIdentityOwned === true,
      executionToken: asText(payload.executionToken),
      authOwnershipToken: asText(payload.authOwnershipToken),
      status: asText(payload.status),
    };
  }

  async recoverIdentity(requestId: string, executionToken: string): Promise<IdentityOutcome> {
    const { data, error } = await this.client.rpc('recover_staff_provisioning_identity', {
      p_request_id: requestId,
      p_execution_token: executionToken,
    });
    if (error) throw new Error('STAFF_PROVISIONING_RECOVERY_FAILED');

    const payload = asRecord(data);
    return {
      resultCode: String(payload.resultCode ?? ''),
      authUserId: asText(payload.authUserId),
      authIdentityOwned: payload.authIdentityOwned === true,
    };
  }

  async bind(
    requestId: string,
    executionToken: string,
    authUserId: string,
  ): Promise<IdentityOutcome> {
    const { data, error } = await this.client.rpc('bind_staff_provisioning_identity', {
      p_request_id: requestId,
      p_execution_token: executionToken,
      p_auth_user_id: authUserId,
    });
    if (error) throw new Error('STAFF_PROVISIONING_BIND_FAILED');

    const payload = asRecord(data);
    return {
      resultCode: String(payload.resultCode ?? ''),
      authUserId: asText(payload.authUserId),
      authIdentityOwned: payload.authIdentityOwned === true,
    };
  }

  async finalize(requestId: string, executionToken: string): Promise<FinalizeOutcome> {
    const { data, error } = await this.client.rpc('finalize_staff_provisioning', {
      p_request_id: requestId,
      p_execution_token: executionToken,
    });
    if (error) throw new Error('STAFF_PROVISIONING_FINALIZE_FAILED');

    const payload = asRecord(data);
    return {
      resultCode: String(payload.resultCode ?? ''),
      adminUserId: asText(payload.adminUserId),
      status: asText(payload.status),
    };
  }

  async finalizeAndActivate(requestId: string, executionToken: string): Promise<FinalizeOutcome> {
    const { data, error } = await this.client.rpc('finalize_and_activate_staff_provisioning', {
      p_request_id: requestId,
      p_execution_token: executionToken,
    });
    if (error) throw new Error('STAFF_PROVISIONING_FINALIZE_ACTIVATE_FAILED');

    const payload = asRecord(data);
    return {
      resultCode: String(payload.resultCode ?? ''),
      adminUserId: asText(payload.adminUserId),
      status: asText(payload.status),
    };
  }

  async beginCompensation(
    requestId: string,
    executionToken: string,
    authUserId: string,
  ): Promise<TransitionOutcome> {
    const { data, error } = await this.client.rpc('begin_staff_provisioning_compensation', {
      p_request_id: requestId,
      p_execution_token: executionToken,
      p_auth_user_id: authUserId,
    });
    if (error) throw new Error('STAFF_PROVISIONING_COMPENSATION_AUTH_FAILED');
    return { resultCode: String(asRecord(data).resultCode ?? '') };
  }

  async fail(
    requestId: string,
    executionToken: string,
    failureCode: string,
    compensationState: 'not_required' | 'succeeded' | 'failed',
  ): Promise<TransitionOutcome> {
    const { data, error } = await this.client.rpc('fail_staff_provisioning', {
      p_request_id: requestId,
      p_execution_token: executionToken,
      p_failure_code: failureCode,
      p_compensation_state: compensationState,
    });
    if (error) throw new Error('STAFF_PROVISIONING_FAIL_RECORD_FAILED');
    return { resultCode: String(asRecord(data).resultCode ?? '') };
  }
}

/**
 * Supabase Auth administrative invitation gateway.
 *
 * Uses the platform's invitation mechanism. Supabase Auth generates and emails the invite link;
 * the application never manually generates, stores, logs or renders its credential. The two
 * ownership fields below are consumed by Migration 0022's Auth insert trigger before persistence.
 */
export class SupabaseStaffInvitationGateway implements StaffInvitationGateway {
  constructor(private readonly client: SupabaseClient) {}

  async invite(input: {
    email: string;
    fullName: string;
    requestId: string;
    authOwnershipToken: string;
  }): Promise<string | null> {
    const { data, error } = await this.client.auth.admin.inviteUserByEmail(input.email, {
      data: {
        full_name: input.fullName,
        staff_provisioning_request_id: input.requestId,
        staff_provisioning_ownership_token: input.authOwnershipToken,
      },
    });
    if (
      error
      || !data?.user?.id
    ) {
      // Bounded operational code only. The provider response may contain identifying detail and
      // is deliberately never logged.
      console.error('[Staff Provisioning]: INVITATION_FAILED');
      return null;
    }
    return data.user.id;
  }

  async deleteAuthIdentity(authUserId: string): Promise<boolean> {
    return deleteOwnedAuthIdentity(this.client, authUserId);
  }
}

/** Server-only direct password identity boundary used exclusively by the staging UAT path. */
export class SupabaseStaffPasswordIdentityGateway implements StaffPasswordIdentityGateway {
  constructor(private readonly client: SupabaseClient) {}

  async createPasswordIdentity(input: {
    email: string;
    fullName: string;
    password: string;
    requestId: string;
    authOwnershipToken: string;
  }): Promise<string | null> {
    const { data, error } = await this.client.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: {
        full_name: input.fullName,
        staff_provisioning_request_id: input.requestId,
        staff_provisioning_ownership_token: input.authOwnershipToken,
      },
    });

    if (error || !data?.user?.id) {
      console.error('[Staff Test Account]: ACCOUNT_CREATION_FAILED');
      return null;
    }
    return data.user.id;
  }

  async deleteAuthIdentity(authUserId: string): Promise<boolean> {
    return deleteOwnedAuthIdentity(this.client, authUserId);
  }
}

async function deleteOwnedAuthIdentity(
  client: SupabaseClient,
  authUserId: string,
): Promise<boolean> {
  const { error } = await client.auth.admin.deleteUser(authUserId);
  if (error) {
    console.error('[Staff Provisioning]: COMPENSATION_DELETE_FAILED');
    return false;
  }
  return true;
}

/** Bounded, non-identifying view of a provisioned or pending staff member for the Admin/CMS. */
export interface StaffDirectoryEntry {
  fullName: string;
  email: string;
  roles: AdminRole[];
  status: 'active' | 'pending_activation';
  requestedAt: string | null;
}

/** Bounded view of a provisioning lifecycle that never produced a usable staff account. */
export interface StaffProvisioningIncident {
  fullName: string;
  email: string;
  roles: AdminRole[];
  status: 'compensating' | 'failed' | 'compensation_failed';
  failureCode: string | null;
  requestedAt: string | null;
}
