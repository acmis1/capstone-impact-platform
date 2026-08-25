import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_REQUIRED_TABLES,
  REQUIRED_RPC_NAMES,
} from '../deployment/hostedDeploymentReadiness';

/**
 * The Local Supabase runtime verifier restates the authoritative inventory sizes as literals so a
 * schema change cannot pass unnoticed. Those literals previously drifted from the exported
 * inventory and only failed inside the slow Disposable Local Supabase job, after the stack had
 * already been provisioned. These contract tests fail in the fast static suite instead, while
 * keeping the exact-equality tripwire the runtime verifier depends on.
 */
const source = fs.readFileSync(
  path.join(__dirname, 'verifyHostedReadinessInspectionRuntime.ts'),
  'utf8',
);

function assertedLiteral(expression: string): number {
  const marker = `assert.equal(${expression}, `;
  const start = source.indexOf(marker);
  expect(start, `No exact-equality assertion found for ${expression}.`).toBeGreaterThan(-1);
  const literal = source.slice(start + marker.length, source.indexOf(')', start));
  expect(literal).toMatch(/^\d+$/);
  return Number(literal);
}

describe('Hosted readiness inspection runtime inventory literals', () => {
  it('asserts the exact current required RPC name count', () => {
    expect(assertedLiteral('REQUIRED_RPC_NAMES.length')).toBe(REQUIRED_RPC_NAMES.length);
  });

  it('asserts the exact current required table count', () => {
    expect(assertedLiteral('ALL_REQUIRED_TABLES.length')).toBe(ALL_REQUIRED_TABLES.length);
  });

  it('reports the same RPC name count in its operator-facing evidence line', () => {
    const reported = source.match(/console\.log\('(\d+) RPC names recognized/);
    expect(reported).not.toBeNull();
    expect(Number(reported![1])).toBe(REQUIRED_RPC_NAMES.length);
  });

  it('keeps the exact-equality form rather than a lower bound', () => {
    expect(source).not.toMatch(/assert\.ok\(\s*REQUIRED_RPC_NAMES\.length\s*>=/);
    expect(source).not.toMatch(/assert\.ok\(\s*ALL_REQUIRED_TABLES\.length\s*>=/);
  });
});
