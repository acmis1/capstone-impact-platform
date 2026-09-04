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

/**
 * The CONFIG-MANAGED baseline buckets. `infra/supabase/config.toml` declares exactly these three,
 * the Supabase CLI creates them when a stack starts, and this seeder reconciles them.
 *
 * This is deliberately NOT the complete release/recovery inventory. The fourth canonical bucket,
 * `participant-corrections-private`, is created and configured by Migration 0051 with
 * `ON CONFLICT (id) DO NOTHING`. Pre-creating it here (or in `config.toml`) would let the CLI win
 * the race and leave the migration's own bucket contract unproven, so nothing outside that
 * migration may create or update it. See MIGRATION_MANAGED_BUCKETS below, and
 * REQUIRED_STORAGE_BUCKETS / CANONICAL_STORAGE_BUCKETS for the four-bucket release inventory.
 */
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

/**
 * The MIGRATION-MANAGED bucket. Migration 0051 owns its creation and its exact configuration; this
 * is a read-only mirror of that authority so verifiers can assert the bucket without provisioning
 * it. `participantOwnedCorrectionMigration.test.ts` pins this constant to the migration bytes, so
 * the migration stays the source of truth. Never seed, create, or update this bucket from
 * application or fixture code.
 */
export const MIGRATION_MANAGED_BUCKETS: BucketSpec[] = [
  {
    name: 'participant-corrections-private',
    isPublic: false,
    fileSizeLimit: 20971520, // 20 MB
    allowedMimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/pdf',
    ],
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
  // Deterministic blank one-page PDF; xref offsets and seed.sql size match these ASCII bytes.
  const syntheticPosterPdfBuffer = Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>\nendobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
    'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n203\n%%EOF\n',
    'ascii'
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

  // Upload Medical Drone's approved-but-not-yet-published private media fixtures.
  const medicalDronePosterImagePath = 'drafts/2026-medical-drone/poster_image/poster.png';
  const { error: uploadMedicalDroneImageErr } = await client.storage
    .from(privateBucket)
    .upload(medicalDronePosterImagePath, syntheticPosterBuffer, { contentType: 'image/png', upsert: true });

  if (uploadMedicalDroneImageErr) {
    throw new Error('Failed to upload Medical Drone private poster image fixture.');
  }

  const { data: medicalDroneImageList, error: listMedicalDroneImageErr } = await client.storage
    .from(privateBucket)
    .list('drafts/2026-medical-drone/poster_image', { search: 'poster.png' });

  if (
    listMedicalDroneImageErr ||
    !medicalDroneImageList ||
    !medicalDroneImageList.some((file) => file.name === 'poster.png')
  ) {
    throw new Error('Verification failed: Uploaded Medical Drone private poster image fixture object missing.');
  }
  fixturesUploaded.push(`${privateBucket}:${medicalDronePosterImagePath}`);

  const medicalDronePosterPdfPath = 'drafts/2026-medical-drone/poster_pdf/poster.pdf';
  const { error: uploadMedicalDronePdfErr } = await client.storage
    .from(privateBucket)
    .upload(medicalDronePosterPdfPath, syntheticPosterPdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (uploadMedicalDronePdfErr) {
    throw new Error('Failed to upload Medical Drone private poster PDF fixture.');
  }

  const { data: medicalDronePdfList, error: listMedicalDronePdfErr } = await client.storage
    .from(privateBucket)
    .list('drafts/2026-medical-drone/poster_pdf', { search: 'poster.pdf' });

  if (
    listMedicalDronePdfErr ||
    !medicalDronePdfList ||
    !medicalDronePdfList.some((file) => file.name === 'poster.pdf')
  ) {
    throw new Error('Verification failed: Uploaded Medical Drone private poster PDF fixture object missing.');
  }

  // Reconcile only the known synthetic PDF metadata row. The conditional update is intentionally
  // fail-closed so a missing or drifted row cannot cause an unrelated media asset to be changed.
  const { data: reconciledMedicalDronePdf, error: reconcileMedicalDronePdfErr } = await client
    .from('media_assets')
    .update({ file_size_bytes: syntheticPosterPdfBuffer.length })
    .eq('id', 'f0000000-0000-0000-0000-000000000004')
    .eq('project_id', 'e0000000-0000-0000-0000-000000000002')
    .eq('asset_type', 'poster_pdf')
    .eq('file_name', 'poster.pdf')
    .eq('storage_bucket', privateBucket)
    .eq('storage_path', medicalDronePosterPdfPath)
    .is('public_url', null)
    .eq('mime_type', 'application/pdf')
    .eq('is_public_approved', false)
    .select('id,file_size_bytes');

  if (
    reconcileMedicalDronePdfErr ||
    !Array.isArray(reconciledMedicalDronePdf) ||
    reconciledMedicalDronePdf.length !== 1 ||
    reconciledMedicalDronePdf[0]?.id !== 'f0000000-0000-0000-0000-000000000004' ||
    Number(reconciledMedicalDronePdf[0]?.file_size_bytes) !== syntheticPosterPdfBuffer.length
  ) {
    throw new Error('Failed to reconcile Medical Drone poster PDF metadata.');
  }
  fixturesUploaded.push(`${privateBucket}:${medicalDronePosterPdfPath}`);

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
          rawEnv = execSync(cmd, { encoding: 'utf8', cwd: repoRoot, stdio: 'pipe' });
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
