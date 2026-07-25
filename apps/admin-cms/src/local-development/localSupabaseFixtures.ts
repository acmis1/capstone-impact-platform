import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from './localEnvironmentFile';

export interface BucketSpec {
  name: string;
  isPublic: boolean;
  fileSizeLimit: number; // in bytes
  allowedMimeTypes: string[];
}

export const EXPECTED_BUCKETS: BucketSpec[] = [
  {
    name: 'project-drafts-private',
    isPublic: false,
    fileSizeLimit: 20 * 1024 * 1024, // 20 MB
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  },
  {
    name: 'project-public-assets',
    isPublic: true,
    fileSizeLimit: 20 * 1024 * 1024, // 20 MB
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  },
  {
    name: 'public-feeds',
    isPublic: true,
    fileSizeLimit: 10 * 1024 * 1024, // 10 MB
    allowedMimeTypes: ['application/json'],
  },
];

export interface SeedFixturesOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  cliOutput?: string;
}

function normalizeMimeTypes(mimeTypes?: string[] | null): string[] {
  if (!mimeTypes || !Array.isArray(mimeTypes)) return [];
  return [...mimeTypes].map((m) => m.toLowerCase().trim()).sort();
}

function areMimeTypesEqual(a?: string[] | null, b?: string[] | null): boolean {
  const normA = normalizeMimeTypes(a);
  const normB = normalizeMimeTypes(b);
  if (normA.length !== normB.length) return false;
  return normA.every((val, index) => val === normB[index]);
}

/**
 * Worker function containing storage bucket reconciliation and fixture upload logic.
 * Used directly by unit tests with a mock Supabase client.
 */
export async function seedLocalSupabaseFixturesWorker(client: SupabaseClient): Promise<{
  bucketsVerified: string[];
  fixturesUploaded: string[];
}> {
  const bucketsVerified: string[] = [];
  const fixturesUploaded: string[] = [];

  // 1. List existing buckets with retry for transient container startup readiness
  let existingBuckets: Array<{ name: string; public: boolean; file_size_limit?: number | string | null; allowed_mime_types?: string[] | null }> = [];
  let listErr: unknown = null;

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await client.storage.listBuckets();
      if (!res.error && Array.isArray(res.data)) {
        existingBuckets = res.data;
        listErr = null;
        break;
      }
      listErr = res.error || new Error('Storage listBuckets returned no data.');
    } catch (err) {
      listErr = err;
    }
    if (attempt < 10) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  if (listErr) {
    throw new Error('Failed to list local storage buckets.');
  }

  const existingMap = new Map((existingBuckets || []).map((b) => [b.name, b]));

  for (const spec of EXPECTED_BUCKETS) {
    const existing = existingMap.get(spec.name);
    if (!existing) {
      const { error: createErr } = await client.storage.createBucket(spec.name, {
        public: spec.isPublic,
        fileSizeLimit: spec.fileSizeLimit,
        allowedMimeTypes: spec.allowedMimeTypes,
      });
      if (createErr) {
        throw new Error('Failed to create local storage bucket.');
      }
    } else {
      const existingSize = existing.file_size_limit != null ? Number(existing.file_size_limit) : null;
      const isPublicDiffers = existing.public !== spec.isPublic;
      const isSizeDiffers = existingSize !== spec.fileSizeLimit;
      const isMimeDiffers = !areMimeTypesEqual(existing.allowed_mime_types, spec.allowedMimeTypes);

      if (isPublicDiffers || isSizeDiffers || isMimeDiffers) {
        const { error: updateErr } = await client.storage.updateBucket(spec.name, {
          public: spec.isPublic,
          fileSizeLimit: spec.fileSizeLimit,
          allowedMimeTypes: spec.allowedMimeTypes,
        });
        if (updateErr) {
          throw new Error('Failed to update local storage bucket properties.');
        }
      }
    }

    // Retrieve bucket post create/update and verify all properties match exact expected contract
    const { data: retrieved, error: getErr } = await client.storage.getBucket(spec.name);
    if (getErr || !retrieved) {
      throw new Error('Failed to verify created or updated bucket.');
    }

    const retSize = retrieved.file_size_limit != null ? Number(retrieved.file_size_limit) : null;
    if (
      retrieved.public !== spec.isPublic ||
      retSize !== spec.fileSizeLimit ||
      !areMimeTypesEqual(retrieved.allowed_mime_types, spec.allowedMimeTypes)
    ) {
      throw new Error('Storage bucket property mismatch after configuration.');
    }

    bucketsVerified.push(spec.name);
  }

  // 2. Upload synthetic local fixture files
  const syntheticPosterBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  // Upload public fixture
  const publicBucket = 'project-public-assets';
  const publicPath = '2026/traffic-engine/poster.png';
  const { error: uploadPublicErr } = await client.storage
    .from(publicBucket)
    .upload(publicPath, syntheticPosterBuffer, { contentType: 'image/png', upsert: true });

  if (uploadPublicErr) {
    throw new Error('Failed to upload public poster fixture.');
  }

  // Verify public fixture object exists in storage
  const { data: publicList, error: listPublicErr } = await client.storage
    .from(publicBucket)
    .list('2026/traffic-engine', { search: 'poster.png' });

  if (listPublicErr || !publicList || !publicList.some((f) => f.name === 'poster.png')) {
    throw new Error('Verification failed: Uploaded public fixture object missing.');
  }
  fixturesUploaded.push(`${publicBucket}:${publicPath}`);

  // Upload private fixture
  const privateBucket = 'project-drafts-private';
  const privatePath = '2026/hydrogrid/poster.png';
  const { error: uploadPrivateErr } = await client.storage
    .from(privateBucket)
    .upload(privatePath, syntheticPosterBuffer, { contentType: 'image/png', upsert: true });

  if (uploadPrivateErr) {
    throw new Error('Failed to upload private draft fixture.');
  }

  // Verify private fixture object exists in storage
  const { data: privateList, error: listPrivateErr } = await client.storage
    .from(privateBucket)
    .list('2026/hydrogrid', { search: 'poster.png' });

  if (listPrivateErr || !privateList || !privateList.some((f) => f.name === 'poster.png')) {
    throw new Error('Verification failed: Uploaded private fixture object missing.');
  }
  fixturesUploaded.push(`${privateBucket}:${privatePath}`);

  return { bucketsVerified, fixturesUploaded };
}

/**
 * Public local entry point. Always resolves local CLI status and enforces loopback URL validation.
 * Never imports server-only environment modules or contacts hosted endpoints.
 */
export async function seedLocalSupabaseFixtures(options: SeedFixturesOptions = {}): Promise<{
  bucketsVerified: string[];
  fixturesUploaded: string[];
}> {
  let apiUrl = options.supabaseUrl;
  let serviceKey = options.serviceRoleKey;

  if (!apiUrl || !serviceKey) {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const workdir = path.resolve(repoRoot, 'infra');
    const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
    const cmd = `"${cliPath}" status --workdir "${workdir}" -o env`;

    let rawEnv = options.cliOutput || '';
    if (!rawEnv) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          rawEnv = execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
          if (rawEnv.includes('API_URL')) break;
        } catch {
          // retry
        }
        if (attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    try {
      const parsed = parseSupabaseCliEnv(rawEnv);
      apiUrl = parsed.API_URL || apiUrl;
      serviceKey = parsed.SERVICE_ROLE_KEY || serviceKey;
    } catch {
      throw new Error('Local Supabase CLI status query failed.');
    }
  }

  if (!apiUrl || !isLoopbackUrl(apiUrl)) {
    throw new Error('Non-loopback Supabase endpoint rejected.');
  }

  if (!serviceKey) {
    throw new Error('Local service-role administrative key required.');
  }

  const client = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) }),
    },
  });

  return seedLocalSupabaseFixturesWorker(client);
}
