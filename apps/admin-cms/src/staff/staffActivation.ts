import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Bounded outcomes of completing staff activation.
 *
 * `ACTIVATION_MISMATCH` is the expected, benign result for any authenticated identity that is not
 * completing a staff provisioning invitation — for example the bootstrap administrator changing
 * their own password. It deliberately does not identify whose provisioning record was missing.
 */
export type StaffActivationResultCode =
  | 'ACTIVATED'
  | 'ALREADY_ACTIVATED'
  | 'ACTIVATION_MISMATCH'
  | 'ACTIVATION_FAILED';

/**
 * Completes the activation transition for the EXACT authenticated Auth identity.
 *
 * The Auth user ID must come from the server-verified session. No request identifier, target
 * identity or status is accepted from the browser, so a crafted request cannot activate somebody
 * else's provisioning record — the database matches solely on the authenticated identity and
 * fails closed on any mismatch.
 *
 * Deliberately NOT gated by the provisioning enablement flag: disabling the creation of new
 * invitations must never strand a staff member who already holds a valid pending invitation.
 */
export async function completeStaffActivation(
  supabaseAdmin: SupabaseClient,
  authUserId: string,
): Promise<StaffActivationResultCode> {
  if (!authUserId) return 'ACTIVATION_MISMATCH';

  try {
    const { data, error } = await supabaseAdmin.rpc('activate_staff_provisioning', {
      p_auth_user_id: authUserId,
    });
    if (error) {
      console.error('[Staff Activation]: ACTIVATION_FAILED');
      return 'ACTIVATION_FAILED';
    }

    const resultCode =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).resultCode
        : null;

    switch (resultCode) {
      case 'ACTIVATED':
        return 'ACTIVATED';
      case 'ALREADY_ACTIVATED':
        return 'ALREADY_ACTIVATED';
      case 'ACTIVATION_MISMATCH':
        return 'ACTIVATION_MISMATCH';
      default:
        console.error('[Staff Activation]: ACTIVATION_FAILED');
        return 'ACTIVATION_FAILED';
    }
  } catch {
    console.error('[Staff Activation]: ACTIVATION_FAILED');
    return 'ACTIVATION_FAILED';
  }
}
