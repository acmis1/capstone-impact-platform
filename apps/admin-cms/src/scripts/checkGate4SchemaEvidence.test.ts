import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ read: vi.fn(), compare: vi.fn(), validate: vi.fn(), exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: calls.exec }));
vi.mock('node:fs', () => ({ default: {
  readFileSync: calls.read, statSync: () => ({ isFile: () => true, size: 10 }),
  readdirSync: () => ['20260101000000_fixture.sql'],
} }));
vi.mock('../local-development/localStackState', () => ({ configuredProjectId: () => 'test-only' }));
vi.mock('../deployment/gate4SchemaEvidence', async (importOriginal) => ({
  ...await importOriginal<typeof import('../deployment/gate4SchemaEvidence')>(),
  compareGate4Evidence: calls.compare, validateCurrentRepositoryGate4Contract: calls.validate,
}));
import { runGate4SchemaEvidenceCheck } from './checkGate4SchemaEvidence';
const SHA = 'a'.repeat(40);
const EXPECTED = { marker: 'synthetic-local-evidence' };
const priorExitCode = process.exitCode;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('CAPSTONE_GATE4_LOCAL_PROJECT_ID', 'test-only');
  process.exitCode = undefined;
  calls.validate.mockReturnValue([]);
  calls.exec.mockImplementation((file: string, args: string[]) => {
    if (file === 'git' && args[0] === 'status') return '';
    if (file === 'git' && args[0] === 'rev-parse') return SHA;
    if (file === 'docker' && args[0] === 'ps') return 'supabase_db_test-only';
    if (file === 'docker' && args[0] === 'exec') return JSON.stringify(EXPECTED);
    throw new Error('UNEXPECTED_EXTERNAL_COMMAND');
  });
  calls.compare.mockImplementation((expected, actual) => ({
    classification: actual === expected ? 'GATE4_MATCH' : 'EVIDENCE_INVALID',
    validationErrors: [], differences: [], totalDifferences: 0, categoryMatches: {},
  }));
});
afterEach(() => {
  process.exitCode = priorExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Gate 4 CLI evidence-mode isolation', () => {
  it.each([null, { gate4_evidence: null }, { gate4Evidence: null }, [{ gate4_evidence: null }]])(
    'never substitutes local evidence for a null hosted input: %j', (document) => {
      const bytes = Buffer.from(JSON.stringify(document));
      calls.read.mockImplementation((file: string) => file.endsWith('.sql') ? 'SELECT fixture' : bytes);
      runGate4SchemaEvidenceCheck(['--machine-readable', '--evidence-file=fixture.json']);
      expect(calls.compare).toHaveBeenCalledWith(EXPECTED, null);
      expect(process.exitCode).toBe(3);
      const output = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
      expect(output.classification).toBe('EVIDENCE_INVALID');
      expect(output.actualEvidenceSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    },
  );

  it('permits local self-comparison only with the explicit self-check mode, with no hosted hash', () => {
    calls.read.mockReturnValue('SELECT fixture');
    runGate4SchemaEvidenceCheck(['--machine-readable', '--local-self-check']);
    expect(calls.compare).toHaveBeenCalledWith(EXPECTED, EXPECTED);
    expect(process.exitCode).toBe(0);
    const output = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
    expect(output.classification).toBe('GATE4_MATCH');
    expect(output.actualEvidenceSha256).toBeNull();
  });

  it('rejects a mixed local/hosted mode before invoking Git or Docker', () => {
    runGate4SchemaEvidenceCheck(['--local-self-check', '--evidence-file=fixture.json']);
    expect(process.exitCode).toBe(3);
    expect(calls.exec).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
    expect(calls.compare).not.toHaveBeenCalled();
  });
});
