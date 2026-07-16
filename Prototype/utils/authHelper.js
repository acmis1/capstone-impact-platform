import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Retrieves the active security key preferring SUPABASE_SECRET_KEY, with fallback to legacy SUPABASE_SERVICE_ROLE_KEY.
 */
export function getSupabaseKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Extracts the unique project reference subdomain from a Supabase URL using native URL parser.
 * Returns null if the URL is invalid, non-HTTPS, contains credentials, or does not conform to `<ref>.supabase.co`.
 */
export function getProjectRef(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const url = new URL(urlStr);
    
    // Enforce HTTPS
    if (url.protocol !== 'https:') {
      return null;
    }

    // Enforce no embedded credentials
    if (url.username || url.password) {
      return null;
    }

    const host = url.hostname;
    
    // Host must end exactly with .supabase.co
    if (!host.endsWith('.supabase.co')) {
      return null;
    }

    // Host must be exactly `<ref>.supabase.co` with 3 segments
    const parts = host.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const ref = parts[0];
    if (!ref) {
      return null;
    }

    return ref;
  } catch (e) {
    return null;
  }
}

/**
 * Compares the configured project reference against the expected reference, enforcing safety policies.
 * Returns:
 * - 'TARGET_MATCH' if references match and pass safety filters.
 * - 'TARGET_MISMATCH' if reference does not match expected, is non-HTTPS, has credentials, or matches the denied old demo project.
 * - 'TARGET_CONFIGURATION_MISSING' if configuration is incomplete or malformed.
 */
export function verifyProjectRef(urlStr, expectedRef) {
  if (!urlStr || !expectedRef || typeof urlStr !== 'string' || typeof expectedRef !== 'string') {
    return 'TARGET_CONFIGURATION_MISSING';
  }

  // Validate if URL is malformed
  try {
    new URL(urlStr);
  } catch (e) {
    return 'TARGET_CONFIGURATION_MISSING';
  }

  const ref = getProjectRef(urlStr);
  if (!ref) {
    // If getProjectRef returned null, determine if it is mismatch or missing config
    try {
      const parsedUrl = new URL(urlStr);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || !parsedUrl.hostname.endsWith('.supabase.co')) {
        return 'TARGET_MISMATCH';
      }
      return 'TARGET_MISMATCH';
    } catch (err) {
      return 'TARGET_CONFIGURATION_MISSING';
    }
  }

  // Deny writing to the known old Prototype project reference
  const deniedRef = 'xojnnhilqaldxoilmxli';
  if (ref === deniedRef || expectedRef === deniedRef) {
    return 'TARGET_MISMATCH';
  }

  if (ref === expectedRef) {
    return 'TARGET_MATCH';
  }

  return 'TARGET_MISMATCH';
}
