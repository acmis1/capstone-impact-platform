/**
 * Server-side operational enablement for creating NEW staff invitations.
 *
 * Rules:
 * - Fails closed: absent, empty or unrecognized configuration means disabled.
 * - Server-only. The variable is deliberately not `NEXT_PUBLIC_`-prefixed, so the browser can
 *   neither read it nor influence it.
 * - Gates invitation CREATION only. Completing activation of an already-valid pending invitation
 *   is never gated by it, so turning provisioning off cannot strand an invited staff member.
 */
export const STAFF_PROVISIONING_ENABLED_VAR = 'STAFF_PROVISIONING_ENABLED';

/** Only this exact value enables provisioning; everything else is disabled. */
export function isStaffProvisioningEnabledValue(raw: string | undefined | null): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

export function isStaffProvisioningEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isStaffProvisioningEnabledValue(env[STAFF_PROVISIONING_ENABLED_VAR]);
}
