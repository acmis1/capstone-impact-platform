import { describe, expect, it, vi } from 'vitest';

import { createAssistiveCheckResult } from '../domain/evidence';
import {
  ASSISTIVE_PIPELINE_VERSION,
  toPersistedAssistiveFinding,
} from '../domain/persistenceContract';
import type { AssistiveValidationPersistenceGateway } from '../repositories/assistiveValidationRepository';
import {
  loadLatestAssistiveValidationRun,
  persistAssistiveValidationRun,
  recordAssistiveFindingDisposition,
} from '../services/assistiveValidationPersistenceService';

const PROJECT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const RUN_ID = '7b1c1a7e-3b8b-4a4b-9a2e-1f2a3b4c5d6e';
const FINDING_ID = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
const ADMIN_ID = '1d8ea5e2-9b4d-4a4f-b6c9-6b1e6f0a1f11';
const OTHER_ADMIN_ID = '2e9fb6f3-0c5e-4b7a-8d1c-5a4b3c2d1e0f';
const HASH = 'b'.repeat(64);
const CREATED_AT = '2026-08-20T02:00:00+00:00';

const persistedFinding = () => toPersistedAssistiveFinding(createAssistiveCheckResult({
  checkType: 'TITLE_CONSISTENCY',
  outcome: 'MISMATCH',
  classification: 'NON_BLOCKING',
  reasonCode: 'MATERIAL_TOKEN_DIFFERENCE',
  affectedField: 'title',
  origin: 'PHASE_1_EXTRACTION',
  evidenceExcerpt: 'Fire Resilience Mapping',
  pageNumber: 1,
  boundingBox: { left: 12, top: 20, right: 320, bottom: 64, unit: 'PDF_POINTS_TOP_LEFT' },
  metadataValue: 'Flood Resilience Mapping',
  normalizedMetadataValue: 'flood resilience mapping',
  candidateValue: 'Fire Resilience Mapping',
  normalizedCandidateValue: 'fire resilience mapping',
  lexicalScore: 0.71,
  explanation: 'Document title contains a material token difference; it remains non-blocking.',
}));

const validRun = () => ({
  projectId: PROJECT_ID,
  inputHash: HASH,
  pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
  status: 'COMPLETED' as const,
  failureCode: null,
  findings: [persistedFinding()],
});

function gateway(overrides: Partial<AssistiveValidationPersistenceGateway> = {}): AssistiveValidationPersistenceGateway {
  return {
    persistRun: vi.fn().mockResolvedValue({ resultCode: 'PERSISTED', runId: RUN_ID, status: 'COMPLETED', findingCount: 1 }),
    loadLatestRun: vi.fn().mockResolvedValue({ resultCode: 'NOT_FOUND' }),
    recordDisposition: vi.fn().mockResolvedValue({
      resultCode: 'RECORDED', findingId: FINDING_ID, disposition: 'REVIEWED', reviewedBy: ADMIN_ID, reviewedAt: CREATED_AT,
    }),
    ...overrides,
  };
}

describe('persistAssistiveValidationRun', () => {
  it('reports a newly persisted run', async () => {
    const result = await persistAssistiveValidationRun(gateway(), validRun(), ADMIN_ID);
    expect(result).toEqual({
      ok: true, runId: RUN_ID, status: 'COMPLETED', findingCount: 1, alreadyPersisted: false,
    });
  });

  it('reports a converged retry without treating it as a failure', async () => {
    const client = gateway({
      persistRun: vi.fn().mockResolvedValue({
        resultCode: 'ALREADY_PERSISTED', runId: RUN_ID, status: 'COMPLETED', findingCount: 1,
      }),
    });
    const result = await persistAssistiveValidationRun(client, validRun(), ADMIN_ID);
    expect(result).toMatchObject({ ok: true, runId: RUN_ID, alreadyPersisted: true });
  });

  it('maps every bounded database result code to a bounded error code', async () => {
    const cases: [string, string][] = [
      ['IDENTITY_CONFLICT', 'IDENTITY_CONFLICT'],
      ['PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND'],
      ['PERMISSION_DENIED', 'PERMISSION_DENIED'],
      ['VALIDATION_FAILED', 'VALIDATION_FAILED'],
    ];
    for (const [resultCode, expected] of cases) {
      const client = gateway({ persistRun: vi.fn().mockResolvedValue({ resultCode }) });
      const result = await persistAssistiveValidationRun(client, validRun(), ADMIN_ID);
      expect(result).toMatchObject({ ok: false, code: expected });
    }
  });

  it('maps identity conflicts to one bounded application failure', async () => {
    const client = gateway({ persistRun: vi.fn().mockResolvedValue({ resultCode: 'IDENTITY_CONFLICT' }) });
    const result = await persistAssistiveValidationRun(client, validRun(), ADMIN_ID);
    expect(result).toEqual({
      ok: false,
      code: 'IDENTITY_CONFLICT',
      message: 'A durable result already exists for this content identity but does not match the submitted result.',
    });
    expect(JSON.stringify(result)).not.toContain(HASH);
    expect(JSON.stringify(result)).not.toContain(RUN_ID);
  });

  it('rejects invalid input before the database is ever contacted', async () => {
    const client = gateway();
    const cases: unknown[] = [
      { ...validRun(), inputHash: 'A'.repeat(64) },
      { ...validRun(), pipelineVersion: 'gemini-vision/v1 ' },
      { ...validRun(), status: 'RUNNING' },
      { ...validRun(), findings: [] },
      { ...validRun(), findings: [{ ...persistedFinding(), classification: 'BLOCKING' }] },
      { ...validRun(), leaseUntil: CREATED_AT },
      null,
      'not-an-object',
    ];
    for (const input of cases) {
      const result = await persistAssistiveValidationRun(client, input, ADMIN_ID);
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect(client.persistRun).not.toHaveBeenCalled();
  });

  it('never forwards a staff identity that is not a well-formed UUID', async () => {
    const client = gateway();
    for (const actor of ['', 'admin', PROJECT_ID.slice(0, 8), "' OR 1=1 --"]) {
      const result = await persistAssistiveValidationRun(client, validRun(), actor);
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect(client.persistRun).not.toHaveBeenCalled();
  });

  it('forwards the server-derived actor rather than anything inside the payload', async () => {
    const client = gateway();
    await persistAssistiveValidationRun(
      client,
      { ...validRun(), projectId: PROJECT_ID },
      ADMIN_ID,
    );
    expect(client.persistRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, inputHash: HASH }),
      ADMIN_ID,
    );
  });

  it('classifies a thrown database failure without leaking the raw error', async () => {
    const raw = 'duplicate key value violates unique constraint "uq_assistive_validation_runs_completed_identity" DETAIL: Key (project_id)=(3f25...)';
    const client = gateway({ persistRun: vi.fn().mockRejectedValue(new Error(raw)) });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await persistAssistiveValidationRun(client, validRun(), ADMIN_ID);

    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_FAILED' });
    expect(JSON.stringify(result)).not.toContain('duplicate key');
    expect(JSON.stringify(result)).not.toContain('uq_assistive_validation_runs');
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).not.toContain('duplicate key');
    consoleError.mockRestore();
  });

  it('treats an unrecognized or incomplete database response as an internal failure', async () => {
    for (const response of [
      { resultCode: 'APPROVED' },
      { resultCode: 'PERSISTED' },
      { resultCode: 'PERSISTED', runId: RUN_ID, status: 'COMPLETED', findingCount: 0 },
      { resultCode: 'PERSISTED', runId: RUN_ID, status: 'FAILED', findingCount: 1 },
      { resultCode: 'PERSISTED', runId: 'not-a-uuid', status: 'COMPLETED', findingCount: 1 },
      { resultCode: 'PERSISTED', runId: RUN_ID, status: 'CLAIMED', findingCount: 1 },
      { resultCode: 'ALREADY_PERSISTED', runId: RUN_ID, status: 'FAILED', findingCount: 0 },
      { resultCode: 'IDENTITY_CONFLICT', runId: RUN_ID },
      null,
      'PERSISTED',
    ]) {
      const client = gateway({ persistRun: vi.fn().mockResolvedValue(response) });
      const result = await persistAssistiveValidationRun(client, validRun(), ADMIN_ID);
      expect(result).toMatchObject({ ok: false, code: 'INTERNAL_FAILURE' });
    }
  });

  it('rejects unknown fields in every persist RPC response shape', async () => {
    const responses = [
      { resultCode: 'PERSISTED', runId: RUN_ID, status: 'COMPLETED', findingCount: 1 },
      { resultCode: 'ALREADY_PERSISTED', runId: RUN_ID, status: 'COMPLETED', findingCount: 1 },
      { resultCode: 'IDENTITY_CONFLICT' },
      { resultCode: 'PROJECT_NOT_FOUND' },
      { resultCode: 'PERMISSION_DENIED' },
      { resultCode: 'VALIDATION_FAILED' },
    ];
    for (const response of responses) {
      const client = gateway({ persistRun: vi.fn().mockResolvedValue({ ...response, unexpected: true }) });
      expect(await persistAssistiveValidationRun(client, validRun(), ADMIN_ID))
        .toMatchObject({ ok: false, code: 'INTERNAL_FAILURE' });
    }
  });
});

describe('loadLatestAssistiveValidationRun', () => {
  const storedRun = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    inputHash: HASH,
    pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
    status: 'COMPLETED',
    failureCode: null,
    createdAt: CREATED_AT,
  };
  const storedFinding = {
    findingId: FINDING_ID,
    ordinal: 1,
    ...persistedFinding(),
    disposition: 'UNREVIEWED',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: CREATED_AT,
  };

  it('returns the strictly parsed run and findings', async () => {
    const client = gateway({
      loadLatestRun: vi.fn().mockResolvedValue({ resultCode: 'FOUND', run: storedRun, findings: [storedFinding] }),
    });
    const result = await loadLatestAssistiveValidationRun(client, PROJECT_ID, ASSISTIVE_PIPELINE_VERSION);
    expect(result).toMatchObject({ ok: true, found: true });
    if (result.ok && result.found) {
      expect(result.run).toEqual(storedRun);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].classification).toBe('NON_BLOCKING');
    }
  });

  it('reports an absent run without inventing evidence', async () => {
    const result = await loadLatestAssistiveValidationRun(gateway(), PROJECT_ID, ASSISTIVE_PIPELINE_VERSION);
    expect(result).toEqual({ ok: true, found: false });
  });

  it('refuses a stored row that no longer satisfies the persistence contract', async () => {
    const cases: unknown[] = [
      { resultCode: 'FOUND', run: { ...storedRun, status: 'RUNNING' }, findings: [storedFinding] },
      {
        resultCode: 'FOUND',
        run: { ...storedRun, status: 'COMPLETED', failureCode: 'EXTRACTION_FAILED' },
        findings: [storedFinding],
      },
      {
        resultCode: 'FOUND',
        run: { ...storedRun, status: 'FAILED', failureCode: null },
        findings: [],
      },
      { resultCode: 'FOUND', run: storedRun, findings: [{ ...storedFinding, classification: 'BLOCKING' }] },
      {
        resultCode: 'FOUND',
        run: storedRun,
        findings: [{ ...storedFinding, scoreKind: 'LEXICAL_SIMILARITY', scoreValue: null }],
      },
      {
        resultCode: 'FOUND',
        run: storedRun,
        findings: [{ ...storedFinding, scoreKind: null, scoreValue: 0.5 }],
      },
      // A dispositioned finding must never appear without its review timestamp.
      { resultCode: 'FOUND', run: storedRun, findings: [{ ...storedFinding, disposition: 'REVIEWED' }] },
      // An unreviewed finding must never claim reviewer attribution.
      {
        resultCode: 'FOUND',
        run: storedRun,
        findings: [{ ...storedFinding, reviewedBy: ADMIN_ID, reviewedAt: CREATED_AT }],
      },
      { resultCode: 'FOUND', run: storedRun, findings: 'none' },
    ];
    for (const response of cases) {
      const client = gateway({ loadLatestRun: vi.fn().mockResolvedValue(response) });
      const result = await loadLatestAssistiveValidationRun(client, PROJECT_ID, ASSISTIVE_PIPELINE_VERSION);
      expect(result).toMatchObject({ ok: false, code: 'INTERNAL_FAILURE' });
    }
  });

  it('rejects unknown fields and stale result-specific data in every read RPC response shape', async () => {
    const responses = [
      { resultCode: 'FOUND', run: storedRun, findings: [storedFinding], unexpected: true },
      { resultCode: 'NOT_FOUND', unexpected: true },
      { resultCode: 'VALIDATION_FAILED', unexpected: true },
      { resultCode: 'NOT_FOUND', run: storedRun, findings: [storedFinding] },
      { resultCode: 'VALIDATION_FAILED', run: storedRun },
    ];
    for (const response of responses) {
      const client = gateway({ loadLatestRun: vi.fn().mockResolvedValue(response) });
      expect(await loadLatestAssistiveValidationRun(client, PROJECT_ID, ASSISTIVE_PIPELINE_VERSION))
        .toMatchObject({ ok: false, code: 'INTERNAL_FAILURE' });
    }
  });

  it('refuses a run that answers a different project or pipeline than was asked for', async () => {
    const client = gateway({
      loadLatestRun: vi.fn().mockResolvedValue({
        resultCode: 'FOUND',
        run: { ...storedRun, projectId: '11111111-2222-4333-8444-555555555555' },
        findings: [storedFinding],
      }),
    });
    const result = await loadLatestAssistiveValidationRun(client, PROJECT_ID, ASSISTIVE_PIPELINE_VERSION);
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_FAILURE' });
  });

  it('validates the request identity before contacting the database', async () => {
    const client = gateway();
    expect(await loadLatestAssistiveValidationRun(client, 'not-a-uuid', ASSISTIVE_PIPELINE_VERSION))
      .toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(await loadLatestAssistiveValidationRun(client, PROJECT_ID, 'Gemini/v1'))
      .toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(client.loadLatestRun).not.toHaveBeenCalled();
  });
});

describe('recordAssistiveFindingDisposition', () => {
  it('records a reviewer disposition with its server-generated attribution', async () => {
    const client = gateway();
    const result = await recordAssistiveFindingDisposition(client, FINDING_ID, ADMIN_ID, 'REVIEWED');
    expect(result).toEqual({
      ok: true,
      findingId: FINDING_ID,
      disposition: 'REVIEWED',
      reviewedBy: ADMIN_ID,
      reviewedAt: CREATED_AT,
      changed: true,
    });
    expect(client.recordDisposition).toHaveBeenCalledWith(FINDING_ID, ADMIN_ID, 'REVIEWED');
  });

  it('reports an idempotent repeat without claiming a new review happened', async () => {
    const client = gateway({
      recordDisposition: vi.fn().mockResolvedValue({
        resultCode: 'UNCHANGED',
        findingId: FINDING_ID,
        disposition: 'IGNORED',
        reviewedBy: OTHER_ADMIN_ID,
        reviewedAt: CREATED_AT,
      }),
    });
    const result = await recordAssistiveFindingDisposition(client, FINDING_ID, ADMIN_ID, 'IGNORED');
    expect(result).toMatchObject({ ok: true, changed: false, reviewedBy: OTHER_ADMIN_ID });
  });

  it('rejects every disposition that is not durably recordable', async () => {
    const client = gateway();
    for (const disposition of ['UNREVIEWED', 'ACCEPTED', 'APPLIED', 'APPROVED', '', null, 7]) {
      const result = await recordAssistiveFindingDisposition(client, FINDING_ID, ADMIN_ID, disposition);
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect(client.recordDisposition).not.toHaveBeenCalled();
  });

  it('never forwards an actor or finding identity that is not a well-formed UUID', async () => {
    const client = gateway();
    expect(await recordAssistiveFindingDisposition(client, 'finding-1', ADMIN_ID, 'REVIEWED'))
      .toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(await recordAssistiveFindingDisposition(client, FINDING_ID, 'reviewer', 'REVIEWED'))
      .toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(client.recordDisposition).not.toHaveBeenCalled();
  });

  it('maps not-found and permission failures to bounded codes', async () => {
    for (const [resultCode, expected] of [
      ['FINDING_NOT_FOUND', 'FINDING_NOT_FOUND'],
      ['PERMISSION_DENIED', 'PERMISSION_DENIED'],
      ['VALIDATION_FAILED', 'VALIDATION_FAILED'],
    ]) {
      const client = gateway({ recordDisposition: vi.fn().mockResolvedValue({ resultCode }) });
      const result = await recordAssistiveFindingDisposition(client, FINDING_ID, ADMIN_ID, 'REVIEWED');
      expect(result).toMatchObject({ ok: false, code: expected });
    }
  });

  it('refuses a response that reports a different finding, state, or no timestamp', async () => {
    for (const response of [
      { resultCode: 'RECORDED', findingId: RUN_ID, disposition: 'REVIEWED', reviewedBy: ADMIN_ID, reviewedAt: CREATED_AT },
      { resultCode: 'RECORDED', findingId: FINDING_ID, disposition: 'IGNORED', reviewedBy: ADMIN_ID, reviewedAt: CREATED_AT },
      { resultCode: 'RECORDED', findingId: FINDING_ID, disposition: 'UNREVIEWED', reviewedBy: null, reviewedAt: null },
      { resultCode: 'RECORDED', findingId: FINDING_ID, disposition: 'REVIEWED', reviewedBy: ADMIN_ID, reviewedAt: null },
    ]) {
      const client = gateway({ recordDisposition: vi.fn().mockResolvedValue(response) });
      const result = await recordAssistiveFindingDisposition(client, FINDING_ID, ADMIN_ID, 'REVIEWED');
      expect(result).toMatchObject({ ok: false, code: 'INTERNAL_FAILURE' });
    }
  });

  it('rejects unknown fields in every disposition RPC response shape', async () => {
    const responses = [
      {
        resultCode: 'RECORDED', findingId: FINDING_ID, disposition: 'REVIEWED',
        reviewedBy: ADMIN_ID, reviewedAt: CREATED_AT,
      },
      {
        resultCode: 'UNCHANGED', findingId: FINDING_ID, disposition: 'REVIEWED',
        reviewedBy: ADMIN_ID, reviewedAt: CREATED_AT,
      },
      { resultCode: 'FINDING_NOT_FOUND' },
      { resultCode: 'PERMISSION_DENIED' },
      { resultCode: 'VALIDATION_FAILED' },
    ];
    for (const response of responses) {
      const client = gateway({ recordDisposition: vi.fn().mockResolvedValue({ ...response, unexpected: true }) });
      expect(await recordAssistiveFindingDisposition(client, FINDING_ID, ADMIN_ID, 'REVIEWED'))
        .toMatchObject({ ok: false, code: 'INTERNAL_FAILURE' });
    }
  });

  it('classifies a thrown database failure without leaking the raw error', async () => {
    const client = gateway({
      recordDisposition: vi.fn().mockRejectedValue(new Error('permission denied for table assistive_validation_findings')),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await recordAssistiveFindingDisposition(client, FINDING_ID, ADMIN_ID, 'IGNORED');
    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_FAILED' });
    expect(JSON.stringify(result)).not.toContain('permission denied for table');
    consoleError.mockRestore();
  });
});
