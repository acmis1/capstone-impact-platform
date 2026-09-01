import type { SupabaseClient } from '@supabase/supabase-js';
import {
  sha256,
  type BucketConfigurationEvidence,
  type StorageObjectRecord,
} from './recoveryBundle';

/**
 * Storage capture and restore through the supported Supabase Storage API.
 *
 * Object bytes never travel inside the database dump: `storage.objects` and `storage.buckets` are
 * excluded from the logical data backup and rebuilt here instead, so the restore proves the API
 * path an operator would actually use rather than a direct catalog write.
 */

const STORAGE_LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES_PER_PREFIX = 200;
const MAX_PREFIX_DEPTH = 32;
const MAX_OBJECTS_PER_BUCKET = 50_000;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_BUFFERED_BUCKET_BYTES = 512 * 1024 * 1024;

interface StorageListEntry {
  name: string;
  id?: string | null;
  metadata?: Record<string, unknown> | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export function assertSafeObjectKey(key: string): void {
  const segments = key.split('/');
  if (
    key.length === 0
    || key.length > 1_024
    || key.includes('\\')
    || key.startsWith('/')
    || segments.length > MAX_PREFIX_DEPTH
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('UNSAFE_STORAGE_OBJECT_KEY');
  }
}

function metadataString(entry: StorageListEntry, field: string): string | null {
  const value = entry.metadata?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Depth-first listing, because the Storage list API returns one prefix level at a time. */
export async function listBucketObjectKeys(
  client: SupabaseClient,
  bucket: string,
): Promise<Array<{
  key: string;
  contentType: string | null;
  lastModified: string | null;
  version: string | null;
  expectedBytes: number | null;
}>> {
  const discovered: Array<{
    key: string;
    contentType: string | null;
    lastModified: string | null;
    version: string | null;
    expectedBytes: number | null;
  }> = [];
  const pending: string[] = [''];
  const seenPrefixes = new Set<string>();

  while (pending.length > 0) {
    const prefix = pending.pop() as string;
    if (seenPrefixes.has(prefix)) continue;
    seenPrefixes.add(prefix);

    for (let page = 0; page < MAX_LIST_PAGES_PER_PREFIX; page += 1) {
      const { data, error } = await client.storage.from(bucket).list(prefix, {
        limit: STORAGE_LIST_PAGE_SIZE,
        offset: page * STORAGE_LIST_PAGE_SIZE,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error('STORAGE_LIST_FAILED');
      const entries = (data ?? []) as StorageListEntry[];
      for (const entry of entries) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null || entry.id === undefined) {
          if (key.split('/').length < MAX_PREFIX_DEPTH) pending.push(key);
          continue;
        }
        assertSafeObjectKey(key);
        const rawSize = entry.metadata?.size;
        const expectedBytes = typeof rawSize === 'number' && Number.isSafeInteger(rawSize)
          ? rawSize
          : typeof rawSize === 'string' && /^\d+$/.test(rawSize)
            ? Number.parseInt(rawSize, 10)
            : null;
        if (expectedBytes !== null && expectedBytes > MAX_OBJECT_BYTES) {
          throw new Error('STORAGE_OBJECT_SIZE_LIMIT_EXCEEDED');
        }
        discovered.push({
          key,
          contentType: metadataString(entry, 'mimetype'),
          lastModified: entry.updated_at ?? entry.created_at ?? null,
          version: metadataString(entry, 'eTag'),
          expectedBytes,
        });
        if (discovered.length > MAX_OBJECTS_PER_BUCKET) throw new Error('STORAGE_OBJECT_LIMIT_EXCEEDED');
      }
      if (entries.length < STORAGE_LIST_PAGE_SIZE) break;
      if (page + 1 === MAX_LIST_PAGES_PER_PREFIX) throw new Error('STORAGE_LIST_PAGE_LIMIT_EXCEEDED');
    }
  }
  return discovered.sort((left, right) => left.key.localeCompare(right.key));
}

export interface CapturedStorageObject {
  record: StorageObjectRecord;
  content: Buffer;
}

/** Streams objects one at a time so a large bucket is never retained wholly in process memory. */
export async function* iterateBucketObjects(
  client: SupabaseClient,
  bucket: string,
): AsyncGenerator<CapturedStorageObject> {
  const listed = await listBucketObjectKeys(client, bucket);
  for (const entry of listed) {
    const { data, error } = await client.storage.from(bucket).download(entry.key);
    if (error || !data) throw new Error('STORAGE_DOWNLOAD_FAILED');
    const content = Buffer.from(await data.arrayBuffer());
    if (content.length > MAX_OBJECT_BYTES
      || (entry.expectedBytes !== null && content.length !== entry.expectedBytes)) {
      throw new Error('STORAGE_OBJECT_SIZE_MISMATCH');
    }
    yield {
      content,
      record: {
        bucket,
        key: entry.key,
        bytes: content.length,
        sha256: sha256(content),
        contentType: entry.contentType ?? (typeof data.type === 'string' && data.type ? data.type : null),
        lastModified: entry.lastModified,
        version: entry.version,
      },
    };
  }
}

/** Convenience wrapper for bounded tests and callers that explicitly need one complete bucket. */
export async function captureBucketObjects(
  client: SupabaseClient,
  bucket: string,
): Promise<CapturedStorageObject[]> {
  const captured: CapturedStorageObject[] = [];
  let bufferedBytes = 0;
  for await (const object of iterateBucketObjects(client, bucket)) {
    bufferedBytes += object.content.length;
    if (bufferedBytes > MAX_BUFFERED_BUCKET_BYTES) throw new Error('STORAGE_BUCKET_BUFFER_LIMIT_EXCEEDED');
    captured.push(object);
  }
  return captured;
}

export async function readBucketConfigurations(
  client: SupabaseClient,
): Promise<BucketConfigurationEvidence[]> {
  const { data, error } = await client.storage.listBuckets();
  if (error || !data) throw new Error('STORAGE_BUCKET_LIST_FAILED');
  return data
    .map((bucket) => {
      const raw = bucket as unknown as {
        id: string;
        public: boolean;
        file_size_limit?: number | string | null;
        allowed_mime_types?: string[] | null;
      };
      const limit = raw.file_size_limit;
      return {
        id: raw.id,
        name: typeof (bucket as { name?: unknown }).name === 'string'
          ? (bucket as { name: string }).name
          : raw.id,
        public: Boolean(raw.public),
        fileSizeLimit: limit === null || limit === undefined ? null : Number(limit),
        allowedMimeTypes: Array.isArray(raw.allowed_mime_types) ? [...raw.allowed_mime_types].sort() : null,
      } satisfies BucketConfigurationEvidence;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Recreates bucket visibility and policy exactly as captured. */
export async function restoreBucketConfigurations(
  client: SupabaseClient,
  configurations: readonly BucketConfigurationEvidence[],
): Promise<void> {
  const existing = new Set((await readBucketConfigurations(client)).map((bucket) => bucket.id));
  for (const configuration of configurations) {
    if (configuration.name !== configuration.id) throw new Error('STORAGE_BUCKET_IDENTITY_MISMATCH');
    const options = {
      public: configuration.public,
      fileSizeLimit: configuration.fileSizeLimit,
      allowedMimeTypes: configuration.allowedMimeTypes,
    };
    const { error } = existing.has(configuration.id)
      ? await client.storage.updateBucket(configuration.id, options)
      : await client.storage.createBucket(configuration.id, options);
    if (error) throw new Error('STORAGE_BUCKET_RESTORE_FAILED');
  }
}

export async function restoreBucketObjects(
  client: SupabaseClient,
  objects: readonly CapturedStorageObject[],
): Promise<void> {
  for (const object of objects) {
    assertSafeObjectKey(object.record.key);
    const { error } = await client.storage.from(object.record.bucket).upload(
      object.record.key,
      object.content,
      {
        upsert: false,
        ...(object.record.contentType ? { contentType: object.record.contentType } : {}),
      },
    );
    if (error) throw new Error('STORAGE_OBJECT_RESTORE_FAILED');
  }
}

/**
 * Re-reads the restored bucket set through the same API used for capture, so a comparison sees
 * what a reader would actually get rather than what the upload call claimed.
 */
export async function readRestoredObjects(
  client: SupabaseClient,
  buckets: readonly string[],
): Promise<StorageObjectRecord[]> {
  const restored: StorageObjectRecord[] = [];
  for (const bucket of buckets) {
    for await (const captured of iterateBucketObjects(client, bucket)) {
      restored.push(captured.record);
    }
  }
  return restored;
}
