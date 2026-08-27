import { describe, expect, it, vi } from 'vitest';

import { assistiveMutationResponseSchema } from '../domain/jobContract';
import { hashAssistiveInput } from '../domain/inputIdentity';
import { hashDuplicateCorpus } from '../duplicate-detection/duplicateRanker';
import type { AssistiveJobGateway } from '../repositories/assistiveJobRepository';
import type { AssistiveInputGateway } from '../repositories/assistiveInputRepository';
import { enqueueAssistiveValidation } from '../services/assistiveJobService';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const PDF = Buffer.from('%PDF-1.4\n', 'ascii');

function jobs(): AssistiveJobGateway {
  return {
    enqueue: vi.fn().mockResolvedValue({ resultCode: 'ENQUEUED', runId: RUN_ID, status: 'QUEUED' }),
    status: vi.fn(), cancel: vi.fn(), health: vi.fn(), claim: vi.fn(), heartbeat: vi.fn(),
    advance: vi.fn(), supersede: vi.fn(), fail: vi.fn(), finalize: vi.fn(),
  };
}

function inputs(): AssistiveInputGateway {
  return {
    loadProject: vi.fn().mockResolvedValue({
      id: PROJECT_ID, public_id: 'P-1', title: 'Title', summary: 'Summary', background: '', solution: '',
    }),
    loadDuplicateCandidates: vi.fn().mockResolvedValue([]),
    loadPosterAssets: vi.fn().mockResolvedValue([{
      id: '44444444-4444-4444-8444-444444444444', asset_type: 'poster_pdf',
      file_name: 'poster.pdf', storage_bucket: 'private',
      storage_path: 'drafts/P-1/poster_pdf/poster.pdf', mime_type: 'application/pdf',
      file_size_bytes: PDF.length, created_at: '2026-08-20T00:00:00Z',
    }]),
    download: vi.fn().mockResolvedValue(PDF),
  };
}

describe('assistive job service and response contracts', () => {
  it('derives enqueue identity from authoritative title and exact private bytes', async () => {
    const gateway = jobs();
    await expect(enqueueAssistiveValidation(gateway, inputs(), {
      projectId: PROJECT_ID,
      actorAdminUserId: ACTOR_ID,
      privateBucket: 'private',
    })).resolves.toEqual({ resultCode: 'ENQUEUED', runId: RUN_ID, status: 'QUEUED' });
    expect(gateway.enqueue).toHaveBeenCalledWith(
      PROJECT_ID,
      ACTOR_ID,
      hashAssistiveInput({
        title: 'Title', summary: 'Summary', background: '', solution: '',
        documentType: 'PDF', content: PDF, duplicateCorpusSha256: hashDuplicateCorpus([]),
      }).inputHash,
      'assistive-deterministic-checks/v3',
    );
  });

  it('fails closed before enqueue when private input cannot be reconstructed', async () => {
    const gateway = jobs();
    const missing = inputs();
    vi.mocked(missing.loadPosterAssets).mockResolvedValue([]);
    await expect(enqueueAssistiveValidation(gateway, missing, {
      projectId: PROJECT_ID,
      actorAdminUserId: ACTOR_ID,
      privateBucket: 'private',
    })).resolves.toEqual({ resultCode: 'MEDIA_INVALID' });
    expect(gateway.enqueue).not.toHaveBeenCalled();
  });

  it('rejects unknown fields on every mutation response', () => {
    expect(assistiveMutationResponseSchema.safeParse({ resultCode: 'SUPERSEDED' }).success).toBe(true);
    expect(assistiveMutationResponseSchema.safeParse({ resultCode: 'SUPERSEDED', unknown: true }).success).toBe(false);
    expect(assistiveMutationResponseSchema.safeParse({ resultCode: 'HEARTBEAT' }).success).toBe(false);
  });
});
