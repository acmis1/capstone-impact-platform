import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROJECT_CONTROLLED_URL_MAX_LENGTH,
  projectControlledUrlSatisfiesDatabaseContract,
  validateProjectControlledUrl,
} from './projectControlledUrl';

const root = path.resolve(__dirname, '../../../..');
const importMigration = path.join(
  root,
  'infra/supabase/migrations/20260902010606_controlled_project_links_import.sql',
);

const NBSP = '\u00A0';
const ZERO_WIDTH_SPACE = '\u200B';

/**
 * The adversarial corpus. Every entry states the exact expected outcome, so a future change to
 * the validator cannot quietly reclassify an input.
 */
const CORPUS: Array<{ label: string; input: string; expected: 'accept' | string }> = [
  // --- accepted, with the canonical form the pipeline persists -------------------------------
  { label: 'normal HTTPS', input: 'https://example.com/demo', expected: 'accept' },
  { label: 'normal HTTP', input: 'http://example.com/demo', expected: 'accept' },
  { label: 'query string', input: 'https://example.com/demo?ref=poster&id=7', expected: 'accept' },
  { label: 'fragment', input: 'https://example.com/demo#results', expected: 'accept' },
  { label: 'mixed-case scheme', input: 'HtTpS://Example.COM/Demo', expected: 'accept' },
  { label: 'at sign in the path', input: 'https://example.com/team@rmit', expected: 'accept' },
  { label: 'at sign in the query', input: 'https://example.com/d?contact=a@b.com', expected: 'accept' },
  { label: 'bare host', input: 'https://example.com', expected: 'accept' },
  { label: 'explicit port', input: 'https://example.com:8443/demo', expected: 'accept' },
  { label: 'surrounding ASCII whitespace', input: '  https://example.com/demo  ', expected: 'accept' },

  // --- rejected -------------------------------------------------------------------------------
  { label: 'empty authority (WHATWG would repair)', input: 'https:///path', expected: 'MALFORMED' },
  { label: 'single backslash (WHATWG would repair)', input: 'https:\\evil.example.com/x', expected: 'MALFORMED' },
  { label: 'double backslash (WHATWG would repair)', input: 'https:\\\\evil.example.com/x', expected: 'MALFORMED' },
  { label: 'backslash after scheme slashes', input: 'https:/\\evil.example.com/x', expected: 'MALFORMED' },
  { label: 'relative', input: 'demo/index.html', expected: 'MALFORMED' },
  { label: 'root-relative', input: '/local/demo', expected: 'MALFORMED' },
  { label: 'scheme-relative', input: '//example.com/demo', expected: 'MALFORMED' },
  { label: 'scheme with no authority at all', input: 'https:', expected: 'MALFORMED' },
  { label: 'javascript', input: 'javascript:alert(1)', expected: 'UNSAFE_SCHEME' },
  { label: 'vbscript', input: 'vbscript:msgbox(1)', expected: 'UNSAFE_SCHEME' },
  { label: 'data', input: 'data:text/html,<script>alert(1)</script>', expected: 'UNSAFE_SCHEME' },
  { label: 'file', input: 'file:///tmp/demo', expected: 'UNSAFE_SCHEME' },
  { label: 'blob', input: 'blob:https://example.com/6f8a', expected: 'UNSAFE_SCHEME' },
  { label: 'credentials', input: 'https://user:secret@example.com/demo', expected: 'CREDENTIALS' },
  { label: 'username only', input: 'https://user@example.com/demo', expected: 'CREDENTIALS' },
  { label: 'NBSP inside the authority', input: `https://exa${NBSP}mple.com/demo`, expected: 'UNSAFE_CHARACTERS' },
  // A leading NBSP is an ordinary paste artefact. It is trimmed, and the canonical value that
  // gets persisted contains no NBSP at all, so the database contract still holds. This is the
  // exact case that used to diverge: the raw string was persisted, and SQL's `btrim` removes
  // ASCII spaces only, so the RPC rejected what the client had accepted.
  { label: 'NBSP leading', input: `${NBSP}https://example.com/demo`, expected: 'accept' },
  { label: 'zero-width space', input: `https://examp${ZERO_WIDTH_SPACE}le.com/demo`, expected: 'UNSAFE_CHARACTERS' },
  { label: 'ideographic space', input: 'https://example.com/a' + String.fromCharCode(0x3000) + 'b', expected: 'UNSAFE_CHARACTERS' },
  { label: 'TAB', input: 'https://example.com/a\tb', expected: 'UNSAFE_CHARACTERS' },
  { label: 'CR', input: 'https://example.com/a\rb', expected: 'UNSAFE_CHARACTERS' },
  { label: 'LF', input: 'https://example.com/a\nb', expected: 'UNSAFE_CHARACTERS' },
  { label: 'NUL', input: 'https://example.com/a' + String.fromCharCode(0) + 'b', expected: 'UNSAFE_CHARACTERS' },
  { label: 'DEL', input: 'https://example.com/a' + String.fromCharCode(127) + 'b', expected: 'UNSAFE_CHARACTERS' },
  { label: 'interior space', input: 'https://example.com/a b', expected: 'UNSAFE_CHARACTERS' },
  { label: 'blank', input: '   ', expected: 'BLANK' },
  { label: 'empty', input: '', expected: 'BLANK' },
];

const MAX_LENGTH_URL = `https://example.com/${'a'.repeat(PROJECT_CONTROLLED_URL_MAX_LENGTH - 20)}`;

describe('controlled project URL corpus', () => {
  it.each(CORPUS)('$label', ({ input, expected }) => {
    const result = validateProjectControlledUrl(input);

    if (expected === 'accept') {
      expect(result.valid).toBe(true);
      return;
    }

    expect(result).toEqual({ valid: false, reason: expected });
  });

  it('accepts a value at exactly the maximum length', () => {
    expect(MAX_LENGTH_URL).toHaveLength(PROJECT_CONTROLLED_URL_MAX_LENGTH);
    expect(validateProjectControlledUrl(MAX_LENGTH_URL).valid).toBe(true);
  });

  it('rejects a value one character over the maximum length', () => {
    expect(validateProjectControlledUrl(`${MAX_LENGTH_URL}a`)).toEqual({
      valid: false,
      reason: 'TOO_LONG',
    });
  });

  it('rejects a value whose canonical form would exceed the maximum length', () => {
    // Each percent-encoded character triples in length, so this is under the limit as typed and
    // over it once canonicalized. The limit must apply to the value that is actually persisted.
    const input = `https://example.com/${'é'.repeat(PROJECT_CONTROLLED_URL_MAX_LENGTH / 2)}`;

    expect(input.length).toBeLessThanOrEqual(PROJECT_CONTROLLED_URL_MAX_LENGTH);
    expect(validateProjectControlledUrl(input)).toEqual({ valid: false, reason: 'TOO_LONG' });
  });
});

describe('canonicalization', () => {
  it.each([
    ['HtTpS://Example.COM/Demo', 'https://example.com/Demo'],
    ['https://example.com', 'https://example.com/'],
    ['  https://example.com/demo  ', 'https://example.com/demo'],
    ['https://example.com/demo?ref=poster', 'https://example.com/demo?ref=poster'],
    ['https://example.com/demo#results', 'https://example.com/demo#results'],
  ])('canonicalizes %s to %s', (input, canonical) => {
    const result = validateProjectControlledUrl(input);

    expect(result.valid).toBe(true);
    expect(result.valid && result.url).toBe(canonical);
  });

  it('never returns the unrepaired raw input when it differs from the canonical form', () => {
    const result = validateProjectControlledUrl('HTTPS://EXAMPLE.COM');

    expect(result.valid && result.url).not.toBe('HTTPS://EXAMPLE.COM');
    expect(result.valid && result.url).toBe('https://example.com/');
  });
});

describe('TypeScript / SQL parity', () => {
  it('restates the migration predicate that is actually deployed', () => {
    const sql = fs.readFileSync(importMigration, 'utf8');

    // If migration 0049's predicate is ever edited, this test must be revisited rather than the
    // TypeScript mirror silently drifting away from it.
    for (const predicate of [
      "!~* '^https?://[^/?#[:space:]@]+'",
      "~ '[[:space:]]'",
      "~ '[[:cntrl:]]'",
      "~* '^https?://[^/?#]*@'",
    ]) {
      expect(sql).toContain(predicate);
    }

    expect(sql.split('> 2048')).toHaveLength(4); // one length bound per controlled link
  });

  it('accepts nothing the database contract would then reject', () => {
    const accepted = CORPUS
      .filter((entry) => entry.expected === 'accept')
      .map((entry) => validateProjectControlledUrl(entry.input))
      .filter((result) => result.valid)
      .map((result) => (result as { valid: true; url: string }).url);

    expect(accepted).toHaveLength(CORPUS.filter((e) => e.expected === 'accept').length);

    for (const url of [...accepted, MAX_LENGTH_URL]) {
      expect(projectControlledUrlSatisfiesDatabaseContract(url)).toBe(true);
    }
  });

  it('treats an absent optional link as satisfying the database contract', () => {
    // NULLIF(btrim(...), '') makes both of these NULL, which the migration allows.
    expect(projectControlledUrlSatisfiesDatabaseContract('')).toBe(true);
    expect(projectControlledUrlSatisfiesDatabaseContract('   ')).toBe(true);
  });

  it.each([
    'https:///path',
    'https:\\evil.example.com/x',
    'https://user:secret@example.com/demo',
    'https://example.com/a b',
    '//example.com/demo',
  ])('agrees with the database contract in rejecting %s', (value) => {
    expect(validateProjectControlledUrl(value).valid).toBe(false);
    expect(projectControlledUrlSatisfiesDatabaseContract(value)).toBe(false);
  });

  it('does not assert reachability, and says so rather than implying it', () => {
    // Documented, deliberate and unchanged by this work: loopback and private-network hosts are
    // accepted. Whether the showcase should publish one is a separate, unmade policy decision.
    for (const value of [
      'http://localhost:3000/demo',
      'http://127.0.0.1:8080/demo',
      'https://10.0.0.5/demo',
      'https://intranet.internal/demo',
    ]) {
      expect(validateProjectControlledUrl(value).valid).toBe(true);
      expect(projectControlledUrlSatisfiesDatabaseContract(value)).toBe(true);
    }
  });
});
