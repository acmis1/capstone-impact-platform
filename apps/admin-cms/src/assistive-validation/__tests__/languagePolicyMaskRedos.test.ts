import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { maskLanguageText, toPersistedLanguageFindings } from '../domain/languagePolicy';

/**
 * Regression coverage for the camel-case mask pattern and the `internal_uppercase_compound`
 * technical-shape rule. Before this correction both were written with overlapping quantifiers
 * and backtracked super-linearly on hostile near misses (`a` + `A`×n + `_` took ~0.8 s at 26
 * characters and did not finish within 2 s at 34 characters on Node 24.14.1).
 *
 * The pathological cases run the real production functions in a child process with an
 * independently enforced timeout, so a regression fails the test instead of hanging the runner.
 */

const adminAppRoot = fileURLToPath(new URL('../../../', import.meta.url));
const INPUT_HASH = 'a'.repeat(64);

/** The frozen policy pattern, kept verbatim as the reference language for bounded comparison. */
const REFERENCE_CAMEL_CASE = /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g;
const REFERENCE_INTERNAL_UPPERCASE = /^[A-Za-z0-9]*[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/;

function referenceCamelSpans(source: string): Array<{ start: number; end: number }> {
  REFERENCE_CAMEL_CASE.lastIndex = 0;
  return [...source.matchAll(REFERENCE_CAMEL_CASE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Runs production masking in an isolated Node process; `timeoutMs` is enforced by the OS, not by a timer. */
function maskInChildProcess(inputs: string[], timeoutMs: number) {
  const script = [
    "const { maskLanguageText, toPersistedLanguageFindings } = await import('./src/assistive-validation/domain/languagePolicy.ts');",
    'const inputs = JSON.parse(process.env.MASK_INPUTS);',
    'const out = inputs.map((source) => {',
    '  const started = process.hrtime.bigint();',
    '  const masked = maskLanguageText(source);',
    '  const findings = toPersistedLanguageFindings({',
    "    field: 'summary', source, inputHash: 'a'.repeat(64),",
    "    matches: [{ offset: 0, length: Math.min(source.length, 25000), message: 'Possible spelling mistake found.',",
    "      ruleId: 'MORFOLOGIK_RULE_EN_AU', categoryId: 'TYPOS', replacements: ['x'] }],",
    '  });',
    '  return { length: source.length, textLength: masked.text.length, spans: masked.spans, findings: findings.length,',
    '    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };',
    '});',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { cwd: adminAppRoot, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, MASK_INPUTS: JSON.stringify(inputs) } },
  );
}

describe('language mask camel-case pattern', () => {
  const representative = [
    'projectMetadataHash', 'camelCase', 'aB', 'aB1c', 'abcDEF', 'abcDefGhi9', 'x', 'X', 'Abc', 'ABC',
    'a1B', 'aB_', '_aB', 'aB-c', 'iPhone', 'eBay', 'macOS', 'useState',
    'staff reviewProject then publishRecord.', 'no camels here', 'ÄbcDef', 'abcÄ', 'aA', '0fooBar',
    'foo0Bar', 'line1 fooBar\r\nline2 bazQux\n', 'emoji 😀 fooBar 😀', 'tab\tfooBar\tend',
    'aAAAAAAAAAAAAAA', 'aAAAAAAAAAAAAAA_', 'aAAAAAAAAAAAAAA-', 'aAaAaAaAaAaAaA', 'aAaAaAaAaAaAaA_',
    `a${'A'.repeat(12)}_`, `${'a'.repeat(30)}${'B'.repeat(8)}_`, // bounded: the reference pattern itself is exponential here
  ];

  it('masks exactly the spans the frozen policy pattern masks on bounded representative inputs', () => {
    for (const source of representative) {
      const masked = maskLanguageText(source);
      expect(masked.text.length, source).toBe(source.length);
      // The camel-case pattern is last, so its accepted spans are those not already claimed by an
      // earlier pattern; none of these inputs matches an earlier pattern, so the sets must be equal.
      expect(masked.spans, source).toEqual(referenceCamelSpans(source));
    }
    // Earlier patterns still win their overlaps exactly as before.
    expect(maskLanguageText('abc_Def').spans).toEqual([{ start: 0, end: 7 }]);
    expect(maskLanguageText('aB.c').spans).toEqual([{ start: 0, end: 4 }]);
  });

  it('preserves UTF-16 offsets, newlines and span semantics for identifier masking', () => {
    const source = 'Read fooBar 😀\r\nthen bazQux.';
    const masked = maskLanguageText(source);
    expect(masked.spans).toEqual([{ start: 5, end: 11 }, { start: 21, end: 27 }]);
    expect(masked.text).toBe(`Read ${' '.repeat(6)} 😀\r\nthen ${' '.repeat(6)}.`);
    expect(masked.text.length).toBe(source.length);
  });

  it('still suppresses internal-uppercase technical tokens and keeps ordinary spelling findings', () => {
    const spelling = (source: string, length: number) => toPersistedLanguageFindings({
      field: 'summary', source, inputHash: INPUT_HASH,
      matches: [{ offset: 0, length, message: 'Possible spelling mistake found.', ruleId: 'MORFOLOGIK_RULE_EN_AU', categoryId: 'TYPOS', replacements: [source.slice(0, length).toLowerCase()] }],
    });
    expect(spelling('TimescaleDB', 11)).toEqual([]);
    expect(spelling('aB', 2)).toEqual([]);
    expect(spelling('Abc', 3)).toHaveLength(1);
    expect(spelling('abc', 3)).toHaveLength(1);
    for (const token of ['aB', 'Abc', 'abc', 'ABc', 'aBC', 'a1B', 'A1b', 'aA', 'Aa', 'ab', 'AB', 'a', 'aB_']) {
      const findings = spelling(token, token.length);
      // Suppression must agree with the reference regex whenever the token is ASCII alphanumeric
      // and longer than two characters (shorter or non-alphanumeric tokens hit other shape rules).
      if (/^[A-Za-z0-9]{3,}$/.test(token)) {
        expect(findings.length === 0, token).toBe(REFERENCE_INTERNAL_UPPERCASE.test(token));
      }
    }
  });

  it('completes hostile near-miss inputs up to the provider field bound inside an enforced process timeout', () => {
    const hostile = [
      `a${'A'.repeat(16)}_`,
      `a${'A'.repeat(24)}_`,
      `a${'A'.repeat(32)}_`,
      `a${'A'.repeat(1024)}_`,
      `a${'A'.repeat(24_998)}_`,
      `${'aA'.repeat(12_499)}_`,
      `${'a'.repeat(12_500)}${'A'.repeat(12_500)}_`,
    ];
    const result = maskInChildProcess(hostile, 20_000);
    expect(result.error, 'child process timed out or failed to start').toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<{ length: number; textLength: number; spans: unknown[]; findings: number; elapsedMs: number }>;
    expect(rows).toHaveLength(hostile.length);
    for (const [index, row] of rows.entries()) {
      expect(row.textLength).toBe(hostile[index].length);
      expect(row.spans).toEqual([]);
      // The spelling span over the unmasked near miss reaches the technical-shape rule and the
      // plausibility filter; neither may blow up, and neither yields a retained finding.
      expect(row.findings).toBe(0);
    }
  }, 30_000);
});
