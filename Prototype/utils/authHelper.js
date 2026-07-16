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
 * Returns null if the URL is invalid, non-HTTPS, contains credentials, explicit ports, non-root path, queries, or fragments.
 */
export function getProjectRef(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const url = new URL(urlStr);
    
    // Enforce HTTPS
    if (url.protocol !== 'https:') {
      return null;
    }

    // Enforce no username/password
    if (url.username || url.password) {
      return null;
    }

    // Enforce no explicit port
    if (url.port !== '') {
      return null;
    }

    // Enforce no pathname other than '/'
    if (url.pathname !== '/' && url.pathname !== '') {
      return null;
    }

    // Enforce no query/search params
    if (url.search !== '') {
      return null;
    }

    // Enforce no hash/fragment
    if (url.hash !== '') {
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
 * Validates that the expected project reference complies with strict format rules.
 */
export function validateExpectedRef(expectedRef) {
  if (!expectedRef || typeof expectedRef !== 'string') {
    return false;
  }

  // Reject surrounding whitespace (no silent trim)
  if (expectedRef !== expectedRef.trim()) {
    return false;
  }

  // Enforce lowercase ASCII letters and digits only
  const isLowercaseAlphanumeric = /^[a-z0-9]+$/.test(expectedRef);
  if (!isLowercaseAlphanumeric) {
    return false;
  }

  // Reject human-readable project name
  if (expectedRef === 'capstone-prototype-recovery-2026') {
    return false;
  }

  // Reject known deleted Prototype project reference
  const deniedRef = 'xojnnhilqaldxoilmxli';
  if (expectedRef === deniedRef) {
    return false;
  }

  return true;
}

/**
 * Compares the configured project reference against the expected reference, enforcing safety policies.
 * Returns:
 * - 'TARGET_MATCH' if references match and pass safety filters.
 * - 'TARGET_MISMATCH' if reference does not match expected, is non-HTTPS, has credentials, or matches the denied old demo project.
 * - 'TARGET_CONFIGURATION_MISSING' if configuration is incomplete or malformed.
 */
export function verifyProjectRef(urlStr, expectedRef) {
  if (!urlStr || !expectedRef || typeof urlStr !== 'string' || typeof expectedRef !== 'string' || expectedRef.trim() === '') {
    return 'TARGET_CONFIGURATION_MISSING';
  }

  // Validate expected reference format rules
  if (!validateExpectedRef(expectedRef)) {
    return 'TARGET_MISMATCH';
  }

  // Validate if URL is malformed
  try {
    new URL(urlStr);
  } catch (e) {
    return 'TARGET_CONFIGURATION_MISSING';
  }

  const ref = getProjectRef(urlStr);
  if (!ref) {
    try {
      const parsedUrl = new URL(urlStr);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.port !== '' || (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') || parsedUrl.search !== '' || parsedUrl.hash !== '' || !parsedUrl.hostname.endsWith('.supabase.co')) {
        return 'TARGET_MISMATCH';
      }
      return 'TARGET_MISMATCH';
    } catch (err) {
      return 'TARGET_CONFIGURATION_MISSING';
    }
  }

  if (ref === expectedRef) {
    return 'TARGET_MATCH';
  }

  return 'TARGET_MISMATCH';
}
