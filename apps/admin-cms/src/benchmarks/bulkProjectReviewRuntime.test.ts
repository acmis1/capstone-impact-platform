import { describe, expect, it } from 'vitest';
import { cleanupIsClean, runBulkProjectReviewRuntime } from './bulkProjectReviewRuntime';

describe('bulk project review runtime verifier', () => {
  it('rejects non-loopback endpoints before creating a client or touching a service', async () => {
    await expect(runBulkProjectReviewRuntime({
      apiUrl: 'https://example.invalid',
      serviceRoleKey: 'test-only-placeholder',
    })).rejects.toThrow('loopback-only Local Supabase endpoint');
  });

  it('fails cleanup verification when any verifier-owned dependent row remains', () => {
    const clean = {
      projects: 0,
      batches: 0,
      projectDisciplines: 0,
      projectIndustryCategories: 0,
      mediaAssets: 0,
      validationFlags: 0,
      approvalRecords: 0,
      participantPreviews: 0,
      correctionRequests: 0,
      confirmations: 0,
      referencePrograms: 0,
      referenceDisciplines: 0,
      referenceIndustryCategories: 0,
    };
    expect(cleanupIsClean(clean)).toBe(true);
    expect(cleanupIsClean({ ...clean, approvalRecords: 1 })).toBe(false);
    expect(cleanupIsClean({ ...clean, referenceIndustryCategories: 1 })).toBe(false);
  });
});
