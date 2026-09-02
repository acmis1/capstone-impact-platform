export const PROJECT_CONTROLLED_URL_MAX_LENGTH = 2048;

export type ProjectControlledUrlValidation =
  | { valid: true; url: string }
  | {
      valid: false;
      reason:
      | 'BLANK'
      | 'TOO_LONG'
      | 'MALFORMED'
      | 'UNSAFE_SCHEME'
      | 'UNSAFE_CHARACTERS'
      | 'CREDENTIALS';
    };

/**
 * Validates optional staff-authored public project links.
 *
 * Blank is valid because video/demo/repository links are optional.
 * Populated values must be bounded, absolute, credential-free HTTP(S) URLs.
 *
 * Publication applies its own stronger final public-feed/storage policy.
 */
export function validateProjectControlledUrl(
  value: string
): ProjectControlledUrlValidation {
  if (value.length > PROJECT_CONTROLLED_URL_MAX_LENGTH) {
    return { valid: false, reason: 'TOO_LONG' };
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return { valid: false, reason: 'BLANK' };
  }

  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    return { valid: false, reason: 'UNSAFE_CHARACTERS' };
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'MALFORMED' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'UNSAFE_SCHEME' };
  }

  if (parsed.username || parsed.password || !parsed.hostname) {
    return { valid: false, reason: 'CREDENTIALS' };
  }

  return {
    valid: true,
    url: trimmed,
  };
}