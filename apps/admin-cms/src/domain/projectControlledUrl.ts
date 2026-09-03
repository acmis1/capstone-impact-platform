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
 * A literal, intentionally written absolute HTTP(S) form: scheme, `//`, then at least one
 * authority character. Deliberately mirrors the SQL predicate `^https?://[^/?#[:space:]@]+`
 * that migration 0049 applies inside `stage_browser_import_metadata`.
 *
 * Checked BEFORE `new URL()` so WHATWG repair can never rescue an input the database would
 * reject: `https:///path` and `https:\evil.example.com/x` are both repaired by the URL parser
 * into a different origin, so they must fail here rather than be silently rewritten.
 */
const LITERAL_HTTP_AUTHORITY = /^https?:\/\/[^/?#\s@]+/i;

/** Mirrors the SQL predicate `^https?://[^/?#]*@` — an `@` anywhere in the authority. */
const EMBEDDED_CREDENTIALS = /^https?:\/\/[^/?#]*@/i;

/** A leading `scheme:` read from the literal input, without parsing or repairing anything. */
const LITERAL_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;

/**
 * ASCII control characters and DEL (the SQL `[[:cntrl:]]` class), every Unicode whitespace
 * character (a superset of SQL's `[[:space:]]`, which is ASCII-only under a UTF-8 ctype and so
 * would not catch NBSP), and Unicode format characters such as zero-width spaces and BiDi
 * overrides, which are a display-spoofing vector rather than a database concern.
 */
const UNSAFE_CHARACTERS = /[\s\u0000-\u001F\u007F\p{Cf}]/u;

/** The SQL `[[:space:]]` class, ASCII-only, as the database applies it. */
const SQL_SPACE = /[\t\n\v\f\r ]/;

/** The SQL `[[:cntrl:]]` class, as the database applies it. */
const SQL_CONTROL = /[\u0000-\u001F\u007F]/;

/**
 * The exact defence-in-depth contract migration 0049 enforces in SQL, restated in TypeScript.
 *
 * `validateProjectControlledUrl` guarantees every value it accepts satisfies this, so a URL that
 * passes staff-facing validation can never then be rejected opaquely at the RPC boundary. The
 * database check is neither removed nor weakened by this — it remains the final authority.
 */
export function projectControlledUrlSatisfiesDatabaseContract(value: string): boolean {
  if (value.length > PROJECT_CONTROLLED_URL_MAX_LENGTH) return false;

  // The database trims with `btrim`, which removes ASCII spaces only.
  const trimmed = value.replace(/^ +| +$/g, '');

  // NULL after NULLIF: an absent optional link, which the migration allows.
  if (trimmed === '') return true;

  return (
    LITERAL_HTTP_AUTHORITY.test(trimmed)
    && !SQL_SPACE.test(trimmed)
    && !SQL_CONTROL.test(trimmed)
    && !EMBEDDED_CREDENTIALS.test(trimmed)
  );
}

/**
 * Validates optional project-team-authored links imported from `project-details.xlsx`.
 *
 * Blank is valid because the video/demo/repository links are optional.
 *
 * A populated value must be a bounded, literal, absolute, credential-free HTTP(S) URL. It is
 * parsed and returned in canonical form, and that canonical form — never the raw input — is what
 * callers persist, render and compare. Returning the unrepaired raw string was the source of a
 * proven TypeScript/SQL divergence: values the client accepted were rejected by the migration's
 * own predicate, so a staff-visible import failed opaquely at the database boundary.
 *
 * Reachability is deliberately not asserted. Loopback, private-network and intranet HTTP(S)
 * hosts are accepted here exactly as they always have been. Whether the showcase should publish
 * such a link is a separate, unmade policy decision that this validator does not settle.
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

  if (UNSAFE_CHARACTERS.test(trimmed)) {
    return { valid: false, reason: 'UNSAFE_CHARACTERS' };
  }

  const scheme = LITERAL_SCHEME.exec(trimmed);

  if (!scheme) {
    // Relative (`demo/index.html`) and scheme-relative (`//example.com`) forms.
    return { valid: false, reason: 'MALFORMED' };
  }

  const schemeName = scheme[1].toLowerCase();

  if (schemeName !== 'http' && schemeName !== 'https') {
    return { valid: false, reason: 'UNSAFE_SCHEME' };
  }

  if (!LITERAL_HTTP_AUTHORITY.test(trimmed)) {
    return { valid: false, reason: 'MALFORMED' };
  }

  if (EMBEDDED_CREDENTIALS.test(trimmed)) {
    return { valid: false, reason: 'CREDENTIALS' };
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

  const canonical = parsed.href;

  if (canonical.length > PROJECT_CONTROLLED_URL_MAX_LENGTH) {
    return { valid: false, reason: 'TOO_LONG' };
  }

  // Canonicalization percent-encodes and can lengthen the value, so the database contract is
  // re-asserted against the exact string that will be persisted, not against the raw input.
  if (!projectControlledUrlSatisfiesDatabaseContract(canonical)) {
    return { valid: false, reason: 'MALFORMED' };
  }

  return {
    valid: true,
    url: canonical,
  };
}
