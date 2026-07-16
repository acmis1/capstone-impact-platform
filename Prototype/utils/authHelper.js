import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Retrieves the active security key preferring SUPABASE_SECRET_KEY, with fallback to legacy SUPABASE_SERVICE_ROLE_KEY.
 */
export function getSupabaseKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Extracts the unique project reference subdomain from a Supabase URL.
 */
export function getProjectRef(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/https:\/\/([^.]+)\.supabase/);
  return match ? match[1] : null;
}

/**
 * Compares the configured project reference against the expected reference, enforcing safety policies.
 * Returns:
 * - 'TARGET_MATCH' if references match and pass safety filters.
 * - 'TARGET_MISMATCH' if reference does not match expected or matches the denied old demo project.
 * - 'TARGET_CONFIGURATION_MISSING' if configuration is incomplete.
 */
export function verifyProjectRef(url, expectedRef) {
  if (!url || !expectedRef) {
    return 'TARGET_CONFIGURATION_MISSING';
  }

  const ref = getProjectRef(url);
  if (!ref) {
    return 'TARGET_CONFIGURATION_MISSING';
  }

  // Deny writing to the known old Prototype project reference to prevent accidental overwrites
  const deniedRef = 'xojnnhilqaldxoilmxli';
  if (ref === deniedRef) {
    return 'TARGET_MISMATCH';
  }

  if (ref === expectedRef) {
    return 'TARGET_MATCH';
  }

  return 'TARGET_MISMATCH';
}
