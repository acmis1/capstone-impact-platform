import type { SupabaseClient } from '@supabase/supabase-js';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeDatabaseProbeSchema,
  assertSafeStorageObjectPath,
  assertSafeStorageProbeBucket,
  listStorageObjectPaths,
  resolveLocalRecoverySupabaseWorkdir,
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
  it('uses the canonical Supabase workdir by default', () => {
    const repoRoot = path.resolve('synthetic-repository-root');

    expect(resolveLocalRecoverySupabaseWorkdir(repoRoot)).toBe(path.join(repoRoot, 'infra'));
  });

  it('uses an explicitly provided disposable Supabase workdir', () => {
    const repoRoot = path.resolve('synthetic-repository-root');
    const disposableWorkdir = path.join(repoRoot, '.tmp', 'disposable-recovery', 'infra');

    expect(resolveLocalRecoverySupabaseWorkdir(repoRoot, disposableWorkdir)).toBe(
      disposableWorkdir,
    );
  });

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
  function successfulCommands(options: {
    cleanupFails?: boolean;
    ownershipProbeFails?: boolean;
    restoredOwnership?: 'OWNED' | 'UNOWNED';
    restoreFails?: boolean;
    setupFails?: boolean;
  } = {}): DatabaseProbeCommands & {
    events: string[];
    psql: ReturnType<typeof vi.fn>;
    restoreSchema: ReturnType<typeof vi.fn>;
  } {
    const events: string[] = [];
    let ownershipMarker = '';
    let dropCalls = 0;
    const psql = vi.fn((sql: string) => {
      if (sql.startsWith('CREATE SCHEMA')) {
        events.push('create-owned-schema');
        ownershipMarker = sql.match(/capstone-recovery-owner-v1:[a-f0-9]{64}/)?.[0] ?? '';
        return '';
      }
      if (sql.includes('CREATE TABLE')) {
        events.push('create-fixture');
        if (options.setupFails) throw new Error('raw setup detail');
        return '';
      }
      if (sql.startsWith('SELECT CASE WHEN EXISTS') && sql.includes('obj_description')) {
        events.push(`prove-restored-ownership:${options.restoredOwnership ?? 'OWNED'}`);
        if (options.ownershipProbeFails) throw new Error('raw ownership inspection detail');
        if (!ownershipMarker || !sql.includes(`= '${ownershipMarker}'`)) return 'UNOWNED\n';
        return `${options.restoredOwnership ?? 'OWNED'}\n`;
      }
      if (sql.includes('DO $capstone_recovery$') && sql.includes('DROP SCHEMA')) {
        dropCalls += 1;
        events.push(`drop-owned-schema:${dropCalls}`);
        if (options.cleanupFails && dropCalls === 2) throw new Error('raw cleanup detail');
        return '';
      }
      if (sql.includes('to_regnamespace')) {
        events.push('inspect-schema-absence');
        return 'ABSENT\n';
      }
      if (sql.includes('SELECT id::text')) {
        events.push('verify-restored-row');
        return `1|${PAYLOAD}|${CHECKSUM}\n`;
      }
      return '';
    });
    const restoreSchema = vi.fn(() => {
      events.push('restore-schema');
      if (options.restoreFails) throw new Error('raw restore detail');
    });
    return {
      events,
      psql,
      dumpSchema: vi.fn(() => {
        events.push('dump-schema');
        return Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(128)]);
      }),
      restoreSchema,
    };
  }

  it('backs up an ownership marker, proves it after restore, verifies, and cleans', () => {
    const commands = successfulCommands();
    const result = runDatabaseRecoveryProbeWithCommands(SCHEMA, commands);

    expect(result).toEqual({ dumpBytes: 133, restoredRows: 1, residueAbsent: true });
    expect(commands.dumpSchema).toHaveBeenCalledWith(SCHEMA);
    expect(commands.restoreSchema).toHaveBeenCalledTimes(1);
    const createSql = commands.psql.mock.calls.find(([sql]) => sql.startsWith('CREATE SCHEMA'))?.[0];
    const marker = createSql?.match(/capstone-recovery-owner-v1:[a-f0-9]{64}/)?.[0];
    const ownershipSql = commands.psql.mock.calls.find(
      ([sql]) => sql.startsWith('SELECT CASE WHEN EXISTS') && sql.includes('obj_description'),
    )?.[0];
    expect(marker).toBeTruthy();
    expect(ownershipSql).toContain(`= '${marker}'`);
    expect(commands.events).toEqual([
      'inspect-schema-absence',
      'create-owned-schema',
      'create-fixture',
      'dump-schema',
      'drop-owned-schema:1',
      'restore-schema',
      'prove-restored-ownership:OWNED',
      'verify-restored-row',
      'drop-owned-schema:2',
      'inspect-schema-absence',
    ]);
    expect(commands.psql.mock.calls.at(-1)?.[0]).toContain('to_regnamespace');
  });

  it('cleans a partial restore only when its exact ownership marker is present', () => {
    const commands = successfulCommands({ restoreFails: true });

    expect(() => runDatabaseRecoveryProbeWithCommands(SCHEMA, commands)).toThrow(
      'DATABASE_BACKUP_RESTORE_FAILED',
    );
    expect(commands.events).toContain('prove-restored-ownership:OWNED');
    expect(commands.events.filter((event) => event.startsWith('drop-owned-schema'))).toHaveLength(2);
    expect(commands.psql.mock.calls.at(-1)?.[0]).toContain('to_regnamespace');
  });

  it('reports cleanup failure ahead of the primary operation failure', () => {
    const commands = successfulCommands({ cleanupFails: true, restoreFails: true });

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

  it('never removes a competing schema created after the absence check', () => {
    const psql = vi.fn((sql: string) => {
      if (sql.includes('to_regnamespace')) return 'ABSENT\n';
      if (sql.startsWith('CREATE SCHEMA')) throw new Error('schema already exists');
      return '';
    });
    const commands: DatabaseProbeCommands = {
      psql,
      dumpSchema: vi.fn(),
      restoreSchema: vi.fn(),
    };

    expect(() => runDatabaseRecoveryProbeWithCommands(SCHEMA, commands)).toThrow(
      'DATABASE_BACKUP_RESTORE_FAILED',
    );
    expect(psql.mock.calls.some(([sql]) => sql.includes('DROP SCHEMA'))).toBe(false);
  });

  it('cleans a schema owned by this run when setup fails after creation', () => {
    const commands = successfulCommands({ setupFails: true });

    expect(() => runDatabaseRecoveryProbeWithCommands(SCHEMA, commands)).toThrow(
      'DATABASE_BACKUP_RESTORE_FAILED',
    );
    expect(commands.events.filter((event) => event.startsWith('drop-owned-schema'))).toEqual([
      'drop-owned-schema:1',
    ]);
  });

  it('revokes ownership after intentional loss and never drops a post-loss competitor', () => {
    const commands = successfulCommands({ restoredOwnership: 'UNOWNED', restoreFails: true });

    expect(() => runDatabaseRecoveryProbeWithCommands(SCHEMA, commands)).toThrow(
      'DATABASE_BACKUP_RESTORE_FAILED',
    );
    expect(commands.events).toEqual([
      'inspect-schema-absence',
      'create-owned-schema',
      'create-fixture',
      'dump-schema',
      'drop-owned-schema:1',
      'restore-schema',
      'prove-restored-ownership:UNOWNED',
    ]);
    expect(commands.events.filter((event) => event.startsWith('drop-owned-schema'))).toHaveLength(1);
  });

  it('does not clean after restore when ownership inspection itself fails', () => {
    const commands = successfulCommands({ ownershipProbeFails: true, restoreFails: true });

    expect(() => runDatabaseRecoveryProbeWithCommands(SCHEMA, commands)).toThrow(
      'DATABASE_BACKUP_RESTORE_FAILED',
    );
    expect(commands.events.filter((event) => event.startsWith('drop-owned-schema'))).toEqual([
      'drop-owned-schema:1',
    ]);
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
  function fakeLocalStorage(
    options: { failFirstUpload?: boolean; competingBucketWinsCreateRace?: boolean } = {},
  ): {
    client: SupabaseClient;
    buckets: Map<string, { public: boolean; file_size_limit: number; allowed_mime_types: string[] }>;
    objects: Map<string, Map<string, { content: Buffer; contentType: string }>>;
    mutatedBuckets: string[];
    emptiedBuckets: string[];
    deletedBuckets: string[];
  } {
    const buckets = new Map([
      ['project-drafts-private', { public: false, file_size_limit: 20 * 1024 * 1024, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] }],
      ['project-public-assets', { public: true, file_size_limit: 20 * 1024 * 1024, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] }],
      ['public-feeds', { public: true, file_size_limit: 10 * 1024 * 1024, allowed_mime_types: ['application/json'] }],
    ]);
    const objects = new Map<string, Map<string, { content: Buffer; contentType: string }>>();
    const mutatedBuckets: string[] = [];
    const emptiedBuckets: string[] = [];
    const deletedBuckets: string[] = [];
    let createAttempts = 0;
    let uploadAttempts = 0;

    const client = {
      storage: {
        listBuckets: async () => ({
          data: [...buckets].map(([name, config]) => ({ name, ...config })),
          error: null,
        }),
        getBucket: async (name: string) => ({ data: buckets.get(name) ?? null, error: buckets.has(name) ? null : new Error('missing') }),
        createBucket: async (name: string, config: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }) => {
          createAttempts += 1;
          if (options.competingBucketWinsCreateRace && createAttempts === 1) {
            buckets.set(name, {
              public: false,
              file_size_limit: 1024,
              allowed_mime_types: ['text/plain'],
            });
            objects.set(name, new Map([[
              'competitor.txt',
              { content: Buffer.from('competitor-owned'), contentType: 'text/plain' },
            ]]));
            return { data: null, error: new Error('bucket already exists') };
          }
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
          emptiedBuckets.push(name);
          objects.get(name)?.clear();
          return { data: {}, error: null };
        },
        deleteBucket: async (name: string) => {
          mutatedBuckets.push(name);
          deletedBuckets.push(name);
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

    return { client, buckets, objects, mutatedBuckets, emptiedBuckets, deletedBuckets };
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
    expect(new Set(fake.emptiedBuckets)).toEqual(new Set([BUCKET]));
    expect(new Set(fake.deletedBuckets)).toEqual(new Set([BUCKET]));
  });

  it('cleans the probe bucket when a Storage operation fails', async () => {
    const fake = fakeLocalStorage({ failFirstUpload: true });
    await expect(runStorageRecoveryProbe(fake.client, BUCKET)).rejects.toThrow(
      'STORAGE_BACKUP_RESTORE_FAILED',
    );
    expect(fake.buckets.has(BUCKET)).toBe(false);
    expect(new Set(fake.mutatedBuckets)).toEqual(new Set([BUCKET]));
    expect(fake.emptiedBuckets).toEqual([BUCKET]);
    expect(fake.deletedBuckets).toEqual([BUCKET]);
  });

  it('never empties or deletes a competing bucket created after the absence check', async () => {
    const fake = fakeLocalStorage({ competingBucketWinsCreateRace: true });

    await expect(runStorageRecoveryProbe(fake.client, BUCKET)).rejects.toThrow(
      'STORAGE_BACKUP_RESTORE_FAILED',
    );
    expect(fake.buckets.has(BUCKET)).toBe(true);
    expect(fake.objects.get(BUCKET)?.get('competitor.txt')?.content.toString('utf8')).toBe(
      'competitor-owned',
    );
    expect(fake.emptiedBuckets).not.toContain(BUCKET);
    expect(fake.deletedBuckets).not.toContain(BUCKET);
  });
});
