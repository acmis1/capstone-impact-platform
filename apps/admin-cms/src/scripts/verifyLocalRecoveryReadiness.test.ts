import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeDatabaseProbeSchema,
  assertSafeStorageObjectPath,
  assertSafeStorageProbeBucket,
  listStorageObjectPaths,
  runDatabaseRecoveryProbeWithCommands,
  runStorageRecoveryProbe,
  sha256,
  validateRecoveryPreflight,
  type DatabaseProbeCommands,
} from './verifyLocalRecoveryReadiness';

const SCHEMA = 'capstone_recovery_probe_0123456789abcdef';
const BUCKET = 'capstone-recovery-probe-0123456789abcdef';
const PAYLOAD = 'synthetic-local-recovery-payload';
const CHECKSUM = sha256(Buffer.from(PAYLOAD, 'utf8'));

describe('Local recovery readiness safety contract', () => {
  it('accepts only verifier-owned database schemas and Storage buckets', () => {
    expect(() => assertSafeDatabaseProbeSchema(SCHEMA)).not.toThrow();
    expect(() => assertSafeStorageProbeBucket(BUCKET)).not.toThrow();

    expect(() => assertSafeDatabaseProbeSchema('public')).toThrow('UNSAFE_DATABASE_PROBE_SCHEMA');
    expect(() => assertSafeDatabaseProbeSchema(`${SCHEMA}; DROP SCHEMA public`)).toThrow(
      'UNSAFE_DATABASE_PROBE_SCHEMA',
    );
    expect(() => assertSafeStorageProbeBucket('project-public-assets')).toThrow(
      'UNSAFE_STORAGE_PROBE_BUCKET',
    );
  });

  it.each(['', '/absolute', '../escape', 'safe/../escape', 'safe\\windows', 'double//separator'])(
    'rejects unsafe Storage object path %j',
    (objectPath) => {
      expect(() => assertSafeStorageObjectPath(objectPath)).toThrow('UNSAFE_STORAGE_OBJECT_PATH');
    },
  );

  it('fails closed unless the exact Local stack is running on loopback', () => {
    expect(validateRecoveryPreflight({
      stackState: 'RUNNING',
      apiUrl: 'http://127.0.0.1:54321',
      serviceRoleKey: 'synthetic-local-key',
      projectId: 'capstone-impact-platform',
    })).toEqual({ databaseContainer: 'supabase_db_capstone-impact-platform' });

    expect(() => validateRecoveryPreflight({
      stackState: 'RUNNING',
      apiUrl: 'https://hosted.invalid',
      serviceRoleKey: 'synthetic-local-key',
      projectId: 'capstone-impact-platform',
    })).toThrow('NON_LOOPBACK_SUPABASE_REJECTED');
    expect(() => validateRecoveryPreflight({
      stackState: 'DEGRADED',
      apiUrl: 'http://127.0.0.1:54321',
      serviceRoleKey: 'synthetic-local-key',
      projectId: 'capstone-impact-platform',
    })).toThrow('LOCAL_SUPABASE_NOT_READY');
  });
});

describe('database backup and restore probe', () => {
  function successfulCommands(): DatabaseProbeCommands & { psql: ReturnType<typeof vi.fn> } {
    const psql = vi.fn((sql: string) => {
      if (sql.includes('to_regnamespace')) {
        return 'ABSENT\n';
      }
      if (sql.includes('SELECT id::text')) return `1|${PAYLOAD}|${CHECKSUM}\n`;
      return '';
    });
    return {
      psql,
      dumpSchema: vi.fn(() => Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(128)])),
      restoreSchema: vi.fn(),
    };
  }

  it('backs up, removes, restores, verifies, and cleans the synthetic schema', () => {
    const commands = successfulCommands();
    const result = runDatabaseRecoveryProbeWithCommands(SCHEMA, commands);

    expect(result).toEqual({ dumpBytes: 133, restoredRows: 1, residueAbsent: true });
    expect(commands.dumpSchema).toHaveBeenCalledWith(SCHEMA);
    expect(commands.restoreSchema).toHaveBeenCalledTimes(1);
    expect(commands.psql.mock.calls.some(([sql]) => sql.includes(`DROP SCHEMA "${SCHEMA}" CASCADE`))).toBe(true);
    expect(commands.psql.mock.calls.at(-1)?.[0]).toContain('to_regnamespace');
  });

  it('still removes the verifier-owned schema when restore fails', () => {
    const commands = successfulCommands();
    commands.restoreSchema = vi.fn(() => {
      throw new Error('raw restore detail');
    });

    expect(() => runDatabaseRecoveryProbeWithCommands(SCHEMA, commands)).toThrow(
      'DATABASE_BACKUP_RESTORE_FAILED',
    );
    expect(commands.psql.mock.calls.at(-2)?.[0]).toContain('DROP SCHEMA IF EXISTS');
    expect(commands.psql.mock.calls.at(-1)?.[0]).toContain('to_regnamespace');
  });

  it('reports cleanup failure ahead of the primary operation failure', () => {
    const commands = successfulCommands();
    commands.restoreSchema = vi.fn(() => {
      throw new Error('raw restore detail');
    });
    commands.psql.mockImplementation((sql: string) => {
      if (sql.includes('DROP SCHEMA IF EXISTS')) throw new Error('raw cleanup detail');
      if (sql.includes('to_regnamespace')) return 'ABSENT\n';
      return '';
    });

    expect(() => runDatabaseRecoveryProbeWithCommands(SCHEMA, commands)).toThrow(
      'DATABASE_PROBE_CLEANUP_FAILED',
    );
  });

  it('never removes a pre-existing probe-name collision', () => {
    const psql = vi.fn((sql: string) => {
      void sql;
      return 'PRESENT\n';
    });
    const commands: DatabaseProbeCommands = {
      psql,
      dumpSchema: vi.fn(),
      restoreSchema: vi.fn(),
    };

    expect(() => runDatabaseRecoveryProbeWithCommands(SCHEMA, commands)).toThrow(
      'DATABASE_PROBE_COLLISION',
    );
    expect(psql).toHaveBeenCalledTimes(1);
    expect(psql.mock.calls[0][0]).toContain('to_regnamespace');
  });
});

describe('Storage backup discovery', () => {
  it('discovers nested object paths without treating folder entries as objects', async () => {
    const list = vi.fn(async (prefix: string) => {
      if (prefix === '') {
        return {
          data: [
            { name: 'evidence', id: null },
            { name: 'payload.bin', id: 'object-1' },
          ],
          error: null,
        };
      }
      if (prefix === 'evidence') {
        return { data: [{ name: 'recovery.json', id: 'object-2' }], error: null };
      }
      return { data: [], error: null };
    });

    await expect(listStorageObjectPaths({ list })).resolves.toEqual([
      'evidence/recovery.json',
      'payload.bin',
    ]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Storage listing returns an error', async () => {
    await expect(listStorageObjectPaths({
      list: vi.fn(async () => ({ data: null, error: new Error('raw provider detail') })),
    })).rejects.toThrow('STORAGE_BACKUP_LIST_FAILED');
  });
});

describe('Storage backup and restore probe', () => {
  function fakeLocalStorage(options: { failFirstUpload?: boolean } = {}): {
    client: SupabaseClient;
    buckets: Map<string, { public: boolean; file_size_limit: number; allowed_mime_types: string[] }>;
    objects: Map<string, Map<string, { content: Buffer; contentType: string }>>;
    mutatedBuckets: string[];
  } {
    const buckets = new Map([
      ['project-drafts-private', { public: false, file_size_limit: 20 * 1024 * 1024, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] }],
      ['project-public-assets', { public: true, file_size_limit: 20 * 1024 * 1024, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] }],
      ['public-feeds', { public: true, file_size_limit: 10 * 1024 * 1024, allowed_mime_types: ['application/json'] }],
    ]);
    const objects = new Map<string, Map<string, { content: Buffer; contentType: string }>>();
    const mutatedBuckets: string[] = [];
    let uploadAttempts = 0;

    const client = {
      storage: {
        listBuckets: async () => ({
          data: [...buckets].map(([name, config]) => ({ name, ...config })),
          error: null,
        }),
        getBucket: async (name: string) => ({ data: buckets.get(name) ?? null, error: buckets.has(name) ? null : new Error('missing') }),
        createBucket: async (name: string, config: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }) => {
          mutatedBuckets.push(name);
          buckets.set(name, {
            public: config.public,
            file_size_limit: config.fileSizeLimit,
            allowed_mime_types: config.allowedMimeTypes,
          });
          objects.set(name, new Map());
          return { data: { name }, error: null };
        },
        emptyBucket: async (name: string) => {
          mutatedBuckets.push(name);
          objects.get(name)?.clear();
          return { data: {}, error: null };
        },
        deleteBucket: async (name: string) => {
          mutatedBuckets.push(name);
          buckets.delete(name);
          objects.delete(name);
          return { data: {}, error: null };
        },
        from: (name: string) => ({
          upload: async (objectPath: string, content: Buffer, uploadOptions: { contentType: string }) => {
            uploadAttempts += 1;
            mutatedBuckets.push(name);
            if (options.failFirstUpload && uploadAttempts === 1) return { data: null, error: new Error('upload failed') };
            objects.get(name)?.set(objectPath, { content: Buffer.from(content), contentType: uploadOptions.contentType });
            return { data: { path: objectPath }, error: null };
          },
          download: async (objectPath: string) => {
            const object = objects.get(name)?.get(objectPath);
            const arrayBuffer = object
              ? object.content.buffer.slice(
                  object.content.byteOffset,
                  object.content.byteOffset + object.content.byteLength,
                ) as ArrayBuffer
              : null;
            return object
              ? { data: new Blob([arrayBuffer!], { type: object.contentType }), error: null }
              : { data: null, error: new Error('missing') };
          },
          list: async (prefix: string) => {
            const prefixWithSlash = prefix ? `${prefix}/` : '';
            const entries = new Map<string, { name: string; id: string | null }>();
            for (const objectPath of objects.get(name)?.keys() ?? []) {
              if (!objectPath.startsWith(prefixWithSlash)) continue;
              const remainder = objectPath.slice(prefixWithSlash.length);
              const separator = remainder.indexOf('/');
              const entryName = separator < 0 ? remainder : remainder.slice(0, separator);
              entries.set(entryName, { name: entryName, id: separator < 0 ? `id-${objectPath}` : null });
            }
            return { data: [...entries.values()], error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;

    return { client, buckets, objects, mutatedBuckets };
  }

  it('backs up, removes, restores, verifies, and cleans only the probe bucket', async () => {
    const fake = fakeLocalStorage();
    await expect(runStorageRecoveryProbe(fake.client, BUCKET)).resolves.toEqual({
      backedUpObjects: 2,
      restoredObjects: 2,
      residueAbsent: true,
      canonicalBucketsUnchanged: true,
    });
    expect(fake.buckets.has(BUCKET)).toBe(false);
    expect(fake.objects.has(BUCKET)).toBe(false);
    expect(new Set(fake.mutatedBuckets)).toEqual(new Set([BUCKET]));
  });

  it('cleans the probe bucket when a Storage operation fails', async () => {
    const fake = fakeLocalStorage({ failFirstUpload: true });
    await expect(runStorageRecoveryProbe(fake.client, BUCKET)).rejects.toThrow(
      'STORAGE_BACKUP_RESTORE_FAILED',
    );
    expect(fake.buckets.has(BUCKET)).toBe(false);
    expect(new Set(fake.mutatedBuckets)).toEqual(new Set([BUCKET]));
  });
});
