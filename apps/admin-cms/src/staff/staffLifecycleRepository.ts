import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalizeRoles } from '../auth/permissions';
import type { StaffLifecycleInput, StaffLifecycleState, StaffProviderSync } from './staffLifecycle';
import type {
  StaffAccessProviderGateway,
  StaffLifecycleDatabaseGateway,
  StaffLifecycleDatabaseOutcome,
  StaffProviderAction,
} from './staffLifecycleService';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asPositiveVersion(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function asProviderAction(value: unknown): StaffProviderAction | null {
  return value === 'none' || value === 'disable' || value === 'enable' ? value : null;
}

function asProviderSync(value: unknown): StaffProviderSync | null {
  return value === 'synchronized' || value === 'pending' || value === 'attention_required'
    ? value
    : null;
}

function safeStaff(payload: Record<string, unknown>): StaffLifecycleState | null {
  const email = asText(payload.email);
  const version = asPositiveVersion(payload.version);
  const status = payload.status;
  const providerSync = asProviderSync(payload.providerStatus);
  if (
    !email
    || !version
    || (status !== 'active' && status !== 'pending_activation' && status !== 'deactivated')
    || !providerSync
    || !Array.isArray(payload.roles)
  ) {
    return null;
  }
  return {
    email,
    version,
    status,
    providerSync,
    roles: canonicalizeRoles(payload.roles),
  };
}

function databaseOutcome(data: unknown): StaffLifecycleDatabaseOutcome {
  const payload = asRecord(data);
  return {
    resultCode: String(payload.resultCode ?? ''),
    staff: safeStaff(payload),
    providerAction: asProviderAction(payload.providerAction),
    eventId: asText(payload.eventId),
    reconciliationToken: asText(payload.reconciliationToken),
    authUserId: asText(payload.authUserId),
  };
}

export class SupabaseStaffLifecycleDatabaseGateway implements StaffLifecycleDatabaseGateway {
  constructor(private readonly client: SupabaseClient) {}

  async apply(
    input: StaffLifecycleInput & { actorAdminUserId: string },
  ): Promise<StaffLifecycleDatabaseOutcome> {
    const { data, error } = await this.client.rpc('manage_staff_lifecycle', {
      p_actor_admin_id: input.actorAdminUserId,
      p_target_email: input.targetEmail,
      p_action: input.action,
      p_roles: input.roles,
      p_expected_version: input.expectedVersion,
    });
    if (error) throw new Error('STAFF_LIFECYCLE_UPDATE_FAILED');
    return databaseOutcome(data);
  }

  async claimProviderReconciliation(input: {
    actorAdminUserId: string;
    targetEmail: string;
    expectedVersion: number;
  }): Promise<StaffLifecycleDatabaseOutcome> {
    const { data, error } = await this.client.rpc('claim_staff_provider_reconciliation', {
      p_actor_admin_id: input.actorAdminUserId,
      p_target_email: input.targetEmail,
      p_expected_version: input.expectedVersion,
    });
    if (error) throw new Error('STAFF_PROVIDER_RECONCILIATION_CLAIM_FAILED');
    return databaseOutcome(data);
  }

  async completeProviderReconciliation(input: {
    eventId: string;
    reconciliationToken: string;
    succeeded: boolean;
    failureCode: string | null;
  }): Promise<string> {
    const { data, error } = await this.client.rpc('complete_staff_provider_reconciliation', {
      p_event_id: input.eventId,
      p_reconciliation_token: input.reconciliationToken,
      p_succeeded: input.succeeded,
      p_failure_code: input.failureCode,
    });
    if (error) throw new Error('STAFF_PROVIDER_RECONCILIATION_COMPLETE_FAILED');
    return String(asRecord(data).resultCode ?? '');
  }
}

/** Supabase Auth administrative boundary. No provider response detail is logged or returned. */
export class SupabaseStaffAccessProviderGateway implements StaffAccessProviderGateway {
  constructor(private readonly client: SupabaseClient) {}

  async setAccessEnabled(authUserId: string, enabled: boolean): Promise<boolean> {
    try {
      const { data, error } = await this.client.auth.admin.updateUserById(authUserId, {
        ban_duration: enabled ? 'none' : '876000h',
      });
      if (error || !data.user) {
        console.error('[Staff Lifecycle]: PROVIDER_ACCESS_UPDATE_FAILED');
        return false;
      }
      return true;
    } catch {
      console.error('[Staff Lifecycle]: PROVIDER_ACCESS_UPDATE_FAILED');
      return false;
    }
  }
}
