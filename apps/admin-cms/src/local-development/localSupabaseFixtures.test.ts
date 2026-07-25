import { describe, it, expect, vi } from 'vitest';
import { seedLocalSupabaseFixtures, EXPECTED_BUCKETS } from './localSupabaseFixtures';

describe('Local Supabase Fixtures Unit Tests', () => {
  it('1. Exactly 3 local storage buckets are defined with exact visibility and size limits', () => {
    expect(EXPECTED_BUCKETS.length).toBe(3);
    const bucketNames = EXPECTED_BUCKETS.map((b) => b.name);
    expect(bucketNames).toEqual(['project-drafts-private', 'project-public-assets', 'public-feeds']);

    const drafts = EXPECTED_BUCKETS.find((b) => b.name === 'project-drafts-private');
    expect(drafts?.isPublic).toBe(false);
    expect(drafts?.fileSizeLimit).toBe(20 * 1024 * 1024);

    const publicAssets = EXPECTED_BUCKETS.find((b) => b.name === 'project-public-assets');
    expect(publicAssets?.isPublic).toBe(true);
    expect(publicAssets?.fileSizeLimit).toBe(20 * 1024 * 1024);

    const publicFeeds = EXPECTED_BUCKETS.find((b) => b.name === 'public-feeds');
    expect(publicFeeds?.isPublic).toBe(true);
    expect(publicFeeds?.fileSizeLimit).toBe(10 * 1024 * 1024);
  });

  it('2. Reject non-loopback Supabase URL with generic error without exposing hosted URL or key', async () => {
    const sensitiveUrl = 'https://abcdefghijkl.supabase.co';
    const secretKey = 'sb_secret_key_12345';
    try {
      await seedLocalSupabaseFixtures({
        supabaseUrl: sensitiveUrl,
        serviceRoleKey: secretKey,
      });
      expect.fail('Should have thrown error');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toBe('Non-loopback Supabase endpoint rejected.');
      expect(msg).not.toContain(sensitiveUrl);
      expect(msg).not.toContain(secretKey);
      expect(msg).not.toContain('abcdefghijkl');
    }
  });

  it('3. Fixture creation works with a mocked Supabase storage boundary', async () => {
    const existingBuckets: Array<{ name: string; public: boolean }> = [];
    const mockStorage = {
      listBuckets: vi.fn().mockImplementation(async () => {
        return { data: existingBuckets, error: null };
      }),
      createBucket: vi.fn().mockImplementation(async (name: string, opts: { public: boolean }) => {
        existingBuckets.push({ name, public: opts.public });
        return { error: null };
      }),
      updateBucket: vi.fn().mockResolvedValue({ error: null }),
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ error: null }),
      }),
    };

    const mockClient = {
      storage: mockStorage,
    };

    const res = await seedLocalSupabaseFixtures({
      customClient: mockClient as unknown as import('@supabase/supabase-js').SupabaseClient,
    });
    expect(res.bucketsVerified.length).toBe(3);
    expect(res.fixturesUploaded.length).toBe(2);
  });
});
