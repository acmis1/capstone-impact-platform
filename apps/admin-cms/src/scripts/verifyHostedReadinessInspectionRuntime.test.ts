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

const EXPECTED_PRIVILEGE_HIDDEN_TABLES = [
  'password_recovery_sessions',
  'assistive_validation_runs',
  'assistive_validation_findings',
  'assistive_validation_jobs',
  'assistive_worker_heartbeats',
];

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

  it('asserts the exact privilege-hidden table contract', () => {
    expect(source).toContain(
      `const EXPECTED_PRIVILEGE_HIDDEN_TABLES = [\n${EXPECTED_PRIVILEGE_HIDDEN_TABLES.map((table) => `  '${table}',`).join('\n')}\n] as const;`,
    );
    expect(source).toContain('assert.deepEqual(evaluation.unverifiedTables, EXPECTED_PRIVILEGE_HIDDEN_TABLES);');
  });

  it('derives the operator-facing RPC count from the authoritative inventory', () => {
    expect(source).toContain(
      'console.log(`${REQUIRED_RPC_NAMES.length} RPC names recognized; exact overload evidence remains manual.`);',
    );
  });

  it('keeps the exact-equality form rather than a lower bound', () => {
    expect(source).not.toMatch(/assert\.ok\(\s*REQUIRED_RPC_NAMES\.length\s*>=/);
    expect(source).not.toMatch(/assert\.ok\(\s*ALL_REQUIRED_TABLES\.length\s*>=/);
  });
});
