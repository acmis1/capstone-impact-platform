/**
 * The single normalization and validation contract for the authoritative participant/group contact
 * address, shared by the import pipeline (which persists it) and the notification workflow (which
 * resolves it back out of trusted project data at send time).
 *
 * Deliberately conservative rather than RFC-exhaustive. Its job is not to accept every address a
 * mail system could theoretically route, but to guarantee that whatever this project stores is a
 * single, bounded, control-character-free address that cannot smuggle extra headers or recipients
 * into an outgoing message. Migration 0023 enforces the same shape at the database boundary, so a
 * hand-edited row can never reach transport either.
 */

/** Matches the bound enforced by `check_projects_participant_contact_email` in Migration 0023. */
export const MAX_PARTICIPANT_CONTACT_EMAIL_LENGTH = 254;
export const MIN_PARTICIPANT_CONTACT_EMAIL_LENGTH = 3;

/**
 * One local part, one `@`, and a dotted domain — with no whitespace anywhere. Mirrors the regular
 * expression used by Migration 0023 so application and database agree on exactly one answer.
 */
const PARTICIPANT_CONTACT_EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

/**
 * True when any code point is a C0 or C1 control character. That covers CR and LF and therefore
 * every classic mail-header injection vector. Written as an explicit code-point scan rather than a
 * regular expression so the intent stays legible and no control character is ever embedded in this
 * source file.
 */
export function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export type ParticipantContactEmailRejection = 'MISSING' | 'INVALID';

export type ParticipantContactEmailResult =
  | { valid: true; email: string }
  | { valid: false; reason: ParticipantContactEmailRejection };

/**
 * Deterministic canonical form: surrounding whitespace removed and the whole address lowercased.
 * Never throws, and never partially "repairs" an address — anything unusable is rejected outright
 * rather than silently rewritten into a different destination.
 */
export function normalizeParticipantContactEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/**
 * Validates an already-normalized or raw candidate. `MISSING` and `INVALID` are kept apart because
 * staff need to know whether a contact was never supplied or was supplied badly, and because
 * Generate + Send maps them to distinct bounded domain results.
 */
export function validateParticipantContactEmail(raw: unknown): ParticipantContactEmailResult {
  const email = normalizeParticipantContactEmail(raw);

  if (email.length === 0) {
    return { valid: false, reason: 'MISSING' };
  }

  if (
    email.length < MIN_PARTICIPANT_CONTACT_EMAIL_LENGTH ||
    email.length > MAX_PARTICIPANT_CONTACT_EMAIL_LENGTH ||
    containsControlCharacter(email) ||
    !PARTICIPANT_CONTACT_EMAIL_PATTERN.test(email)
  ) {
    return { valid: false, reason: 'INVALID' };
  }

  return { valid: true, email };
}

/** Convenience predicate for call sites that only need a yes/no answer. */
export function isValidParticipantContactEmail(raw: unknown): boolean {
  return validateParticipantContactEmail(raw).valid;
}
