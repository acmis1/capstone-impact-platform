import { describe, expect, it, vi } from 'vitest';
import {
  prepareBulkPublishCandidates,
  runBulkPublishPreflight,
  runBulkPublish,
  BULK_PUBLISH_MAX_PROJECTS,
  type BulkPublishCandidate,
  type BulkPublishPreflightResult,
} from './bulkPublishCoordinator';

describe('bulkPublishCoordinator', () => {
  describe('prepareBulkPublishCandidates', () => {
    it('rejects empty selections', () => {
      const result = prepareBulkPublishCandidates([]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Select at least one project.');
      expect(result.items).toHaveLength(0);
    });

    it(`enforces maximum selection cap of ${BULK_PUBLISH_MAX_PROJECTS}`, () => {
      const overLimit: BulkPublishCandidate[] = Array.from({ length: 51 }, (_, i) => ({
        publicId: `P-${i + 1}`,
        title: `Project ${i + 1}`,
        status: 'approved',
      }));
      const result = prepareBulkPublishCandidates(overLimit);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(`no more than ${BULK_PUBLISH_MAX_PROJECTS}`);
      expect(result.items).toHaveLength(0);
    });

    it('classifies obvious non-approved rows as ineligible before any network work', () => {
      const candidates: BulkPublishCandidate[] = [
        { publicId: 'draft-1', title: 'Draft Project', status: 'draft' },
        { publicId: 'sub-1', title: 'Submitted Project', status: 'submitted' },
        { publicId: 'cr-1', title: 'Changes Requested Project', status: 'changes_requested' },
        { publicId: 'arch-1', title: 'Archived Project', status: 'archived' },
        { publicId: 'app-1', title: 'Approved Project', status: 'approved' },
      ];

      const result = prepareBulkPublishCandidates(candidates);
      expect(result.valid).toBe(true);
      expect(result.items[0].disposition).toBe('ineligible');
      expect(result.items[0].detail).toContain('only approved projects qualify');
      expect(result.items[1].disposition).toBe('ineligible');
      expect(result.items[2].disposition).toBe('ineligible');
      expect(result.items[3].disposition).toBe('ineligible');
      expect(result.items[4].disposition).toBe('eligible');
    });

    it('does not infer target-feed completion from dashboard published status', () => {
      const candidates: BulkPublishCandidate[] = [
        { publicId: 'pub-1', title: 'Published Project', status: 'published' },
        { publicId: 'app-1', title: 'Approved Project', status: 'approved' },
      ];

      const result = prepareBulkPublishCandidates(candidates);
      expect(result.valid).toBe(true);
      expect(result.items[0].disposition).toBe('ineligible');
      expect(result.items[0].detail).toContain('not authoritative evidence');
      expect(result.items[1].disposition).toBe('eligible');
    });

    it('disallows duplicate selections and invalid publicIds', () => {
      const candidates: BulkPublishCandidate[] = [
        { publicId: 'valid-1', title: 'Valid 1', status: 'approved' },
        { publicId: 'valid-1', title: 'Duplicate 1', status: 'approved' },
        { publicId: 'invalid public id with spaces!', title: 'Bad ID', status: 'approved' },
        { publicId: '', title: 'Empty ID', status: 'approved' },
      ];

      const result = prepareBulkPublishCandidates(candidates);
      expect(result.valid).toBe(true);
      expect(result.items[0].disposition).toBe('eligible');
      expect(result.items[1].disposition).toBe('ineligible');
      expect(result.items[1].detail).toContain('Duplicate selection');
      expect(result.items[2].disposition).toBe('ineligible');
      expect(result.items[2].detail).toContain('Invalid project public ID');
      expect(result.items[3].disposition).toBe('ineligible');
    });
  });

  describe('runBulkPublishPreflight', () => {
    it('preflights approved candidates sequentially against publication-plan endpoint', async () => {
      const calls: string[] = [];
      const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              resultCode: 'READY_TO_STAGE',
              publicId: url.split('/')[3],
              confirmedPreviewId: 'prev-123',
              confirmedAt: '2026-09-16T10:00:00.000Z',
              recordCount: 5,
              feedHash: 'a'.repeat(64),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const candidates: BulkPublishCandidate[] = [
        { publicId: 'P-1', title: 'Project 1', status: 'approved' },
        { publicId: 'P-2', title: 'Project 2', status: 'draft' }, // ineligible, skips network
        { publicId: 'P-3', title: 'Project 3', status: 'approved' },
      ];

      const preflight = await runBulkPublishPreflight({
        candidates,
        fetchImpl: mockFetch as never,
      });

      expect(calls).toEqual([
        '/api/projects/P-1/publication-plan',
        '/api/projects/P-3/publication-plan',
      ]);

      expect(preflight.summary).toEqual({
        total: 3,
        eligible: 2,
        blocked: 0,
        alreadyComplete: 0,
        ineligible: 1,
      });

      expect(preflight.items[0].disposition).toBe('eligible');
      expect(preflight.items[0].feedHash).toBe('a'.repeat(64));
      expect(preflight.items[1].disposition).toBe('ineligible');
      expect(preflight.items[2].disposition).toBe('eligible');
    });

    it('marks candidates with readiness blockers as blocked', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: false,
            result: {
              resultCode: 'NOT_READY',
              readinessCode: 'PREVIEW_NOT_CONFIRMED',
              blockers: ['Participant has not confirmed preview.'],
            },
            error: 'Publication plan is unavailable.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const candidates: BulkPublishCandidate[] = [
        { publicId: 'P-blocked', title: 'Blocked Project', status: 'approved' },
      ];

      const preflight = await runBulkPublishPreflight({
        candidates,
        fetchImpl: mockFetch as never,
      });

      expect(preflight.summary.blocked).toBe(1);
      expect(preflight.items[0].disposition).toBe('blocked');
      expect(preflight.items[0].blockers).toEqual(['Participant has not confirmed preview.']);
    });

    it('marks candidates as blocked on permission denial (403)', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({ success: false, error: 'Permission denied.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const preflight = await runBulkPublishPreflight({
        candidates: [{ publicId: 'P-denied', title: 'Denied Project', status: 'approved' }],
        fetchImpl: mockFetch as never,
      });

      expect(preflight.items[0].disposition).toBe('blocked');
      expect(preflight.items[0].detail).toContain('permission denied');
    });

    it.each([
      ['malformed JSON', new Response('{', { status: 200 })],
      ['oversized JSON', new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-length': String(32 * 1024 + 1) },
      })],
    ])('fails preflight closed for %s', async (_label, response) => {
      const preflight = await runBulkPublishPreflight({
        candidates: [{ publicId: 'P-1', title: 'Project 1', status: 'approved' }],
        fetchImpl: vi.fn(async () => response),
      });

      expect(preflight.summary.eligible).toBe(0);
      expect(preflight.items[0].disposition).toBe('blocked');
      expect(preflight.items[0].detail).toContain('malformed or unreadable');
    });

    it.each([
      ['mismatched publicId', { publicId: 'P-other' }],
      ['missing confirmedPreviewId', { confirmedPreviewId: undefined }],
      ['empty confirmedPreviewId', { confirmedPreviewId: '' }],
      ['invalid confirmedAt', { confirmedAt: 'not-a-time' }],
      ['fractional recordCount', { recordCount: 1.5 }],
      ['negative recordCount', { recordCount: -1 }],
      ['invalid feedHash', { feedHash: 'not-a-hash' }],
    ])('fails closed for READY_TO_STAGE with %s', async (_label, override) => {
      const result = {
        resultCode: 'READY_TO_STAGE',
        publicId: 'P-1',
        confirmedPreviewId: 'prev-1',
        confirmedAt: '2026-09-16T10:00:00.000Z',
        recordCount: 1,
        feedHash: 'a'.repeat(64),
        ...override,
      };
      const preflight = await runBulkPublishPreflight({
        candidates: [{ publicId: 'P-1', title: 'Project 1', status: 'approved' }],
        fetchImpl: vi.fn(async () => new Response(
          JSON.stringify({ success: true, result }),
          { status: 200 },
        )),
      });

      expect(preflight.items[0].disposition).toBe('blocked');
      expect(preflight.summary.eligible).toBe(0);
    });
  });

  describe('runBulkPublish', () => {
    const samplePreflight: BulkPublishPreflightResult = {
      summary: { total: 4, eligible: 2, blocked: 1, alreadyComplete: 0, ineligible: 1 },
      items: [
        {
          publicId: 'P-1',
          title: 'Project 1',
          status: 'approved',
          disposition: 'eligible',
          detail: 'Ready to publish.',
        },
        {
          publicId: 'P-2',
          title: 'Project 2',
          status: 'approved',
          disposition: 'eligible',
          detail: 'Ready to publish.',
        },
        {
          publicId: 'P-3',
          title: 'Project 3',
          status: 'approved',
          disposition: 'blocked',
          detail: 'Participant preview unconfirmed.',
        },
        {
          publicId: 'P-4',
          title: 'Project 4',
          status: 'published',
          disposition: 'ineligible',
          detail: 'Target-feed completion is unverified.',
        },
      ],
    };

    it('executes sequentially through existing per-project endpoints preserving canonical writer serialization', async () => {
      const requestOrder: string[] = [];
      let inFlight = false;
      let concurrentDetected = false;

      const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
        if (inFlight) concurrentDetected = true;
        inFlight = true;
        const url = String(input);
        requestOrder.push(url);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight = false;

        return new Response(
          JSON.stringify({
            success: true,
            result: {
              resultCode: 'COMPLETED',
              publicId: url.split('/')[3],
              snapshotId: 'snap-1',
              recordCount: 10,
              feedHash: 'b'.repeat(64),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const updates: import('./bulkPublishCoordinator').BulkPublishRunResult[] = [];
      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'local',
        fetchImpl: mockFetch as never,
        onUpdate: (update) => updates.push(update),
      });

      expect(updates.length).toBeGreaterThan(0);
      expect(concurrentDetected).toBe(false);
      expect(requestOrder).toEqual([
        '/api/projects/P-1/local-publication',
        '/api/projects/P-2/local-publication',
      ]);
      expect(result.stopped).toBe(false);
      expect(result.items[0].outcome).toBe('COMPLETED');
      expect(result.items[1].outcome).toBe('COMPLETED');
      expect(result.items[2].outcome).toBe('BLOCKED');
      expect(result.items[3].outcome).toBe('BLOCKED');
    });

    it('stops further scheduling on network UNKNOWN results and creates no retry', async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
        callCount += 1;
        const url = String(input);
        if (url.includes('P-1')) {
          throw new TypeError('Network connection lost');
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: { resultCode: 'COMPLETED', publicId: 'P-2', recordCount: 1, feedHash: 'c'.repeat(64) },
          }),
          { status: 200 },
        );
      });

      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'staging',
        fetchImpl: mockFetch as never,
      });

      expect(callCount).toBe(1);
      expect(result.stopped).toBe(true);
      expect(result.stopReason).toContain('inspect state before any retry');
      expect(result.items[0].outcome).toBe('UNKNOWN');
      expect(result.items[0].detail).toContain('interrupted or its result is unknown');
      // Crucial: later unattempted work must remain NOT_ATTEMPTED and NOT mislabeled
      expect(result.items[1].outcome).toBe('NOT_ATTEMPTED');
      expect(result.items[2].outcome).toBe('BLOCKED');
      expect(result.items[3].outcome).toBe('BLOCKED');
    });

    it('preserves an observed completion before an ambiguous writer and never dispatches the third item', async () => {
      const controller = new AbortController();
      const threeReady: BulkPublishPreflightResult = {
        summary: { total: 3, eligible: 3, blocked: 0, alreadyComplete: 0, ineligible: 0 },
        items: [
          { publicId: 'P-1', title: 'Project 1', status: 'approved', disposition: 'eligible', detail: 'Ready.' },
          { publicId: 'P-2', title: 'Project 2', status: 'approved', disposition: 'eligible', detail: 'Ready.' },
          { publicId: 'P-3', title: 'Project 3', status: 'approved', disposition: 'eligible', detail: 'Ready.' },
        ],
      };
      const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
        const publicId = String(input).split('/')[3];
        if (publicId === 'P-2') controller.abort();
        return new Response(JSON.stringify({
          success: true,
          result: {
            resultCode: 'COMPLETED',
            publicId,
            recordCount: 1,
            feedHash: 'c'.repeat(64),
          },
        }), { status: 200 });
      });

      const result = await runBulkPublish({
        preflight: threeReady,
        target: 'local',
        signal: controller.signal,
        fetchImpl: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.stopped).toBe(true);
      expect(result.items.map((item) => item.outcome)).toEqual([
        'COMPLETED',
        'UNKNOWN',
        'NOT_ATTEMPTED',
      ]);
    });

    it('classifies a generic 5xx as UNKNOWN and preserves the unattempted remainder', async () => {
      const mockFetch = vi.fn(async () => new Response(
        JSON.stringify({ success: false, error: 'Publication could not be completed.' }),
        { status: 500 },
      ));

      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'production',
        fetchImpl: mockFetch,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.stopped).toBe(true);
      expect(result.items[0].outcome).toBe('UNKNOWN');
      expect(result.items[0].detail).toContain('may have committed');
      expect(result.items[1].outcome).toBe('NOT_ATTEMPTED');
      expect(result.items[2].outcome).toBe('BLOCKED');
      expect(result.items[3].outcome).toBe('BLOCKED');
    });

    it.each([
      ['malformed', new Response('{', { status: 200 })],
      ['oversized', new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-length': String(32 * 1024 + 1) },
      })],
    ])('stops with UNKNOWN on a %s execution response', async (_label, response) => {
      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'local',
        fetchImpl: vi.fn(async () => response),
      });

      expect(result.items[0].outcome).toBe('UNKNOWN');
      expect(result.items[1].outcome).toBe('NOT_ATTEMPTED');
      expect(result.stopped).toBe(true);
    });

    it('times out an unobserved writer as UNKNOWN without scheduling a retry', async () => {
      const mockFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
      ));

      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'staging',
        fetchImpl: mockFetch,
        timeoutMs: 1,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.items[0].outcome).toBe('UNKNOWN');
      expect(result.items[1].outcome).toBe('NOT_ATTEMPTED');
    });

    it('marks the current writer UNKNOWN and stops when staff aborts the batch', async () => {
      const controller = new AbortController();
      const mockFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          controller.abort();
        })
      ));

      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'production',
        fetchImpl: mockFetch,
        signal: controller.signal,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.items[0].outcome).toBe('UNKNOWN');
      expect(result.items[1].outcome).toBe('NOT_ATTEMPTED');
    });

    it('treats an affirmative unavailable-target response as a known FAILURE and stops', async () => {
      const mockFetch = vi.fn(async () => new Response(JSON.stringify({
        success: false,
        code: 'PRODUCTION_PUBLICATION_UNAVAILABLE',
        error: 'Live showcase publication is unavailable.',
      }), { status: 404 }));

      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'production',
        fetchImpl: mockFetch,
      });

      expect(result.items[0].outcome).toBe('FAILURE');
      expect(result.items[1].outcome).toBe('NOT_ATTEMPTED');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('stops further scheduling on feed conflict or recovery required without mislabeling unattempted work', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'PUBLICATION_IN_PROGRESS',
            error: 'Another publication is already in progress.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'production',
        fetchImpl: mockFetch as never,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.stopped).toBe(true);
      expect(result.items[0].outcome).toBe('FAILURE');
      expect(result.items[0].detail).toContain('writer operation is already in progress');
      expect(result.items[1].outcome).toBe('NOT_ATTEMPTED');
    });

    it('stops further scheduling on permission denial (403)', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({ success: false, error: 'Permission denied.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const result = await runBulkPublish({
        preflight: samplePreflight,
        target: 'local',
        fetchImpl: mockFetch as never,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.stopped).toBe(true);
      expect(result.items[0].outcome).toBe('DENIED');
      expect(result.items[1].outcome).toBe('NOT_ATTEMPTED');
    });

    it('classifies ALREADY_COMPLETED correctly when server returns no-change', async () => {
      const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              resultCode: 'ALREADY_COMPLETED',
              publicId: url.split('/')[3],
              recordCount: 10,
              feedHash: 'd'.repeat(64),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const twoReadyPreflight: BulkPublishPreflightResult = {
        summary: { total: 1, eligible: 1, blocked: 0, alreadyComplete: 0, ineligible: 0 },
        items: [
          { publicId: 'P-1', title: 'Project 1', status: 'approved', disposition: 'eligible', detail: 'Ready.' },
        ],
      };

      const result = await runBulkPublish({
        preflight: twoReadyPreflight,
        target: 'local',
        fetchImpl: mockFetch as never,
      });

      expect(result.items[0].outcome).toBe('ALREADY_COMPLETED');
      expect(result.stopped).toBe(false);
    });
  });
});
