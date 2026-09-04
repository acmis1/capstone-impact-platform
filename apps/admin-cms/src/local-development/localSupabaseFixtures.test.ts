import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  seedLocalSupabaseFixtures,
  seedLocalSupabaseFixturesWorker,
  EXPECTED_BUCKETS,
  MIGRATION_MANAGED_BUCKETS,
} from './localSupabaseFixtures';
import type { SupabaseClient } from '@supabase/supabase-js';
import { REQUIRED_STORAGE_BUCKETS } from '../deployment/hostedDeploymentReadiness';

describe('Local Supabase Fixtures Unit Tests', () => {
  it('1. Exactly 3 config-managed local storage buckets are defined with exact visibility and size limits', () => {
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

  it('never fixture-manages the migration-owned correction bucket', () => {
    // Migration 0051 creates participant-corrections-private with ON CONFLICT (id) DO NOTHING.
    // Seeding it here would let the fixture win that race and leave the migration's own bucket
    // contract unproven, so the three config-managed buckets are deliberately not the complete
    // release/recovery inventory.
    const configManaged = EXPECTED_BUCKETS.map((bucket) => bucket.name);
    const migrationManaged = MIGRATION_MANAGED_BUCKETS.map((bucket) => bucket.name);

    expect(migrationManaged).toEqual(['participant-corrections-private']);
    expect(configManaged).not.toContain('participant-corrections-private');
    expect(configManaged.some((name) => migrationManaged.includes(name))).toBe(false);
    expect([...configManaged, ...migrationManaged].sort())
      .toEqual([...REQUIRED_STORAGE_BUCKETS].sort());
  });

  it('2. Public entry point seedLocalSupabaseFixtures rejects non-loopback Supabase URL with generic error', async () => {
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

  function createMockSupabaseClient(overrides: {
    uploadPublicError?: boolean;
    uploadPrivateError?: boolean;
    missingPublicList?: boolean;
    missingMedicalDronePdfList?: boolean;
    medicalDronePdfMetadata?: Partial<{
      id: string;
      project_id: string;
      asset_type: string;
      file_name: string;
      storage_bucket: string;
      storage_path: string;
      public_url: string | null;
      mime_type: string;
      file_size_bytes: number;
      is_public_approved: boolean;
    }>;
  } = {}) {
    const bucketsMap = new Map<
      string,
      { name: string; public: boolean; file_size_limit: number; allowed_mime_types: string[] }
    >();

    const uploads: Array<{ bucket: string; path: string; contentType: string }> = [];
    const uploadedContents: Array<{ path: string; content: Buffer; upsert: boolean }> = [];
    const listRequests: Array<{ bucket: string; path: string; search?: string }> = [];
    const objects = new Map<string, { name: string }>();
    const mediaRows = [
      {
        id: 'f0000000-0000-0000-0000-000000000004',
        project_id: 'e0000000-0000-0000-0000-000000000002',
        asset_type: 'poster_pdf',
        file_name: 'poster.pdf',
        storage_bucket: 'project-drafts-private',
        storage_path: 'drafts/2026-medical-drone/poster_pdf/poster.pdf',
        public_url: null,
        mime_type: 'application/pdf',
        file_size_bytes: 346,
        is_public_approved: false,
        ...overrides.medicalDronePdfMetadata,
      },
      {
        id: 'f0000000-0000-0000-0000-000000000099',
        project_id: 'e0000000-0000-0000-0000-000000000099',
        asset_type: 'poster_image',
        file_name: 'unrelated.png',
        storage_bucket: 'project-drafts-private',
        storage_path: 'drafts/unrelated/poster_image/unrelated.png',
        public_url: null,
        mime_type: 'image/png',
        file_size_bytes: 123,
        is_public_approved: false,
      },
    ];
    const mediaUpdateRequests: Array<{ values: Record<string, unknown>; matchedIds: string[] }> = [];

    const client = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table !== 'media_assets') throw new Error(`Unexpected table: ${table}`);

        const filters: Array<{ column: string; value: unknown; isNull?: boolean }> = [];
        let updateValues: Record<string, unknown> | null = null;
        const builder = {
          update: vi.fn().mockImplementation((values: Record<string, unknown>) => {
            updateValues = values;
            return builder;
          }),
          eq: vi.fn().mockImplementation((column: string, value: unknown) => {
            filters.push({ column, value });
            return builder;
          }),
          is: vi.fn().mockImplementation((column: string, value: unknown) => {
            filters.push({ column, value, isNull: true });
            return builder;
          }),
          select: vi.fn().mockImplementation(async () => {
            const matches = mediaRows.filter((row) =>
              filters.every((filter) =>
                filter.isNull ? row[filter.column as keyof typeof row] === filter.value : row[filter.column as keyof typeof row] === filter.value
              )
            );
            if (updateValues) {
              mediaUpdateRequests.push({ values: updateValues, matchedIds: matches.map((row) => row.id) });
              matches.forEach((row) => Object.assign(row, updateValues));
            }
            return {
              data: matches.map((row) => ({ id: row.id, file_size_bytes: row.file_size_bytes })),
              error: null,
            };
          }),
        };
        return builder;
      }),
      storage: {
        listBuckets: vi.fn().mockImplementation(async () => {
          return { data: Array.from(bucketsMap.values()), error: null };
        }),
        createBucket: vi.fn().mockImplementation(
          async (name: string, opts: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }) => {
            const item = {
              name,
              public: opts.public,
              file_size_limit: opts.fileSizeLimit,
              allowed_mime_types: opts.allowedMimeTypes,
            };
            bucketsMap.set(name, item);
            return { error: null };
          }
        ),
        updateBucket: vi.fn().mockImplementation(
          async (name: string, opts: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }) => {
            const existing = bucketsMap.get(name) || {
              name,
              public: opts.public,
              file_size_limit: opts.fileSizeLimit,
              allowed_mime_types: opts.allowedMimeTypes,
            };
            const item = {
              ...existing,
              public: opts.public,
              file_size_limit: opts.fileSizeLimit,
              allowed_mime_types: opts.allowedMimeTypes,
            };
            bucketsMap.set(name, item);
            return { error: null };
          }
        ),
        getBucket: vi.fn().mockImplementation(async (name: string) => {
          const item = bucketsMap.get(name);
          return item ? { data: item, error: null } : { data: null, error: new Error('Bucket not found') };
        }),
        from: vi.fn().mockImplementation((bucketName: string) => {
          return {
            upload: vi.fn().mockImplementation(async (storagePath: string, content: Buffer, options: { contentType: string; upsert: boolean }) => {
              if (bucketName === 'project-public-assets' && overrides.uploadPublicError) {
                return { error: new Error('Storage write failed') };
              }
              if (storagePath === '2026/hydrogrid/poster.png' && overrides.uploadPrivateError) {
                return { error: new Error('Storage write failed') };
              }
              uploads.push({ bucket: bucketName, path: storagePath, contentType: options.contentType });
              uploadedContents.push({ path: storagePath, content: Buffer.from(content), upsert: options.upsert });
              objects.set(`${bucketName}:${storagePath}`, { name: storagePath.split('/').at(-1)! });
              return { error: null };
            }),
            list: vi.fn().mockImplementation(async (storagePath: string, options: { search?: string }) => {
              listRequests.push({ bucket: bucketName, path: storagePath, search: options.search });
              if (bucketName === 'project-public-assets' && overrides.missingPublicList) {
                return { data: [], error: null };
              }
              if (
                storagePath === 'drafts/2026-medical-drone/poster_pdf' &&
                overrides.missingMedicalDronePdfList
              ) {
                return { data: [], error: null };
              }
              const prefix = `${bucketName}:${storagePath}/`;
              return {
                data: Array.from(objects)
                  .filter(([key, object]) => key.startsWith(prefix) && (!options.search || object.name === options.search))
                  .map(([, object]) => object),
                error: null,
              };
            }),
          };
        }),
      },
    } as unknown as SupabaseClient;

    return { client, uploads, uploadedContents, listRequests, mediaRows, mediaUpdateRequests };
  }

  it('3. Worker function seedLocalSupabaseFixturesWorker reconciles buckets and uploads fixtures idempotently', async () => {
    const mock = createMockSupabaseClient();
    const res1 = await seedLocalSupabaseFixturesWorker(mock.client);
    expect(res1.bucketsVerified.length).toBe(3);
    expect(res1.fixturesUploaded).toEqual([
      'project-public-assets:2026/traffic-engine/poster.png',
      'project-drafts-private:2026/hydrogrid/poster.png',
      'project-drafts-private:drafts/2026-medical-drone/poster_image/poster.png',
      'project-drafts-private:drafts/2026-medical-drone/poster_pdf/poster.pdf',
    ]);
    expect(mock.uploads).toEqual([
      { bucket: 'project-public-assets', path: '2026/traffic-engine/poster.png', contentType: 'image/png' },
      { bucket: 'project-drafts-private', path: '2026/hydrogrid/poster.png', contentType: 'image/png' },
      { bucket: 'project-drafts-private', path: 'drafts/2026-medical-drone/poster_image/poster.png', contentType: 'image/png' },
      { bucket: 'project-drafts-private', path: 'drafts/2026-medical-drone/poster_pdf/poster.pdf', contentType: 'application/pdf' },
    ]);
    expect(mock.listRequests).toEqual([
      { bucket: 'project-public-assets', path: '2026/traffic-engine', search: 'poster.png' },
      { bucket: 'project-drafts-private', path: '2026/hydrogrid', search: 'poster.png' },
      { bucket: 'project-drafts-private', path: 'drafts/2026-medical-drone/poster_image', search: 'poster.png' },
      { bucket: 'project-drafts-private', path: 'drafts/2026-medical-drone/poster_pdf', search: 'poster.pdf' },
    ]);

    // Second execution remains idempotent
    const res2 = await seedLocalSupabaseFixturesWorker(mock.client);
    expect(res2.bucketsVerified.length).toBe(3);
    expect(res2.fixturesUploaded).toEqual(res1.fixturesUploaded);
  });

  it('uploads a deterministic one-page PDF with valid xref offsets and matching seed metadata', async () => {
    const mock = createMockSupabaseClient();
    await seedLocalSupabaseFixturesWorker(mock.client);
    await seedLocalSupabaseFixturesWorker(mock.client);

    const pdfPath = 'drafts/2026-medical-drone/poster_pdf/poster.pdf';
    const pdfUploads = mock.uploadedContents.filter((upload) => upload.path === pdfPath);
    expect(pdfUploads).toHaveLength(2);
    expect(pdfUploads.every((upload) => upload.upsert)).toBe(true);
    const content = pdfUploads[0].content;
    expect(pdfUploads[1].content.equals(content)).toBe(true);
    expect(content.length).toBe(346);

    // Check this fixed fixture's page tree and byte offsets, not arbitrary uploaded PDFs.
    const pdf = content.toString('ascii');
    expect(pdf).toContain('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
    expect(pdf).toContain('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj');
    expect(pdf).toContain('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>\nendobj');
    const xrefOffset = Number(pdf.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
    expect(pdf.slice(xrefOffset)).toMatch(/^xref\n0 4\n0000000000 65535 f \n/);
    const entries = pdf.slice(xrefOffset).split('\n').slice(3, 6);
    entries.forEach((entry, index) => {
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      expect(pdf.slice(Number(entry.slice(0, 10)))).toMatch(new RegExp(`^${index + 1} 0 obj\\n`));
    });
    expect(pdf).toContain('trailer\n<< /Size 4 /Root 1 0 R >>\n');

    const seed = readFileSync(new URL('../../../../infra/supabase/seed.sql', import.meta.url), 'utf8');
    const seededSize = seed.match(new RegExp(`'${pdfPath.replaceAll('.', '\\.')}',\\s*NULL,\\s*'application/pdf',\\s*(\\d+),\\s*false`));
    expect(Number(seededSize?.[1])).toBe(content.length);
  });

  it('reconciles stale Medical Drone PDF metadata to the uploaded size and remains idempotent', async () => {
    const mock = createMockSupabaseClient({ medicalDronePdfMetadata: { file_size_bytes: 77 } });

    await seedLocalSupabaseFixturesWorker(mock.client);
    expect(mock.mediaRows.find((row) => row.id === 'f0000000-0000-0000-0000-000000000004')?.file_size_bytes).toBe(346);
    expect(mock.mediaRows.find((row) => row.id === 'f0000000-0000-0000-0000-000000000099')?.file_size_bytes).toBe(123);
    expect(mock.mediaUpdateRequests).toEqual([
      { values: { file_size_bytes: 346 }, matchedIds: ['f0000000-0000-0000-0000-000000000004'] },
    ]);

    await seedLocalSupabaseFixturesWorker(mock.client);
    expect(mock.mediaRows.find((row) => row.id === 'f0000000-0000-0000-0000-000000000004')?.file_size_bytes).toBe(346);
    expect(mock.mediaRows.find((row) => row.id === 'f0000000-0000-0000-0000-000000000099')?.file_size_bytes).toBe(123);
    expect(mock.mediaUpdateRequests).toHaveLength(2);
  });

  it('fails closed when the known Medical Drone PDF row has contradictory identity', async () => {
    const mock = createMockSupabaseClient({ medicalDronePdfMetadata: { storage_path: 'drafts/contradictory/poster.pdf' } });

    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Failed to reconcile Medical Drone poster PDF metadata.'
    );
    expect(mock.mediaRows.find((row) => row.id === 'f0000000-0000-0000-0000-000000000004')?.file_size_bytes).toBe(346);
    expect(mock.mediaUpdateRequests).toEqual([
      { values: { file_size_bytes: 346 }, matchedIds: [] },
    ]);
  });

  it('4. Worker function fails with generic error when public fixture upload fails', async () => {
    const mock = createMockSupabaseClient({ uploadPublicError: true });
    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Failed to upload public poster fixture.'
    );
  });

  it('5. Worker function fails with generic error when private fixture upload fails', async () => {
    const mock = createMockSupabaseClient({ uploadPrivateError: true });
    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Failed to upload private draft fixture.'
    );
  });

  it('6. Worker function fails with generic error when post-upload object verification fails', async () => {
    const mock = createMockSupabaseClient({ missingPublicList: true });
    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Verification failed: Uploaded public fixture object missing.'
    );
  });

  it('7. Worker function fails with a generic error when Medical Drone PDF verification fails', async () => {
    const mock = createMockSupabaseClient({ missingMedicalDronePdfList: true });
    await expect(seedLocalSupabaseFixturesWorker(mock.client)).rejects.toThrow(
      'Verification failed: Uploaded Medical Drone private poster PDF fixture object missing.'
    );
  });
});
