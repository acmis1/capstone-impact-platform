import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PRESERVED_EXECUTION_CONTROL_TABLES,
  PRESERVED_PUBLIC_TABLES,
  readStorageEvidence,
} from './runDisposableStagingMigrationUpgrade';

describe('48-to-51 preservation evidence', () => {
  it('covers every table created by the exact first 48 repository migrations', () => {
    const directory = path.resolve(__dirname, '../../../../infra/supabase/migrations');
    const migrations = fs.readdirSync(directory).filter((file) => file.endsWith('.sql')).sort().slice(0, 48);
    expect(migrations.at(-1)).toBe('20260831090000_postgres17_maintain_privilege_alignment.sql');
    const tables = new Set<string>();
    for (const file of migrations) {
      const sql = fs.readFileSync(path.join(directory, file), 'utf8').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
      expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
      // 0001 uses the default public schema; later application DDL explicitly qualifies names.
      for (const match of sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)\s*\(/gi)) {
        tables.add(match[1].includes('.') ? match[1] : `public.${match[1]}`);
      }
    }
    expect(PRESERVED_PUBLIC_TABLES).toHaveLength(37);
    expect(PRESERVED_EXECUTION_CONTROL_TABLES).toHaveLength(3);
    expect([
      ...PRESERVED_PUBLIC_TABLES.map((table) => `public.${table}`),
      ...PRESERVED_EXECUTION_CONTROL_TABLES,
    ].sort()).toEqual([...tables].sort());
  });

  const objects = [
    { bucket: 'project-drafts-private', key: 'synthetic/sentinel.png' },
    { bucket: 'public-feeds', key: 'synthetic/existing.json' },
  ];
  function clientFor(contents: Array<Uint8Array | null>): SupabaseClient {
    return {
      storage: { from: (bucket: string) => ({ download: async (key: string) => {
        const index = objects.findIndex((object) => object.bucket === bucket && object.key === key);
        const bytes = contents[index];
        return bytes
          ? { data: new Blob([Buffer.from(bytes)]), error: null }
          : { data: null, error: { message: 'untrusted storage failure detail' } };
      } }) },
    } as unknown as SupabaseClient;
  }

  it('records all exact keys, lengths and SHA-256 of downloaded bytes, including existing objects', async () => {
    const evidence = await readStorageEvidence(clientFor([Buffer.from('abc'), Buffer.from('{}')]), objects);
    expect(evidence[0]).toEqual({
      ...objects[0], byteLength: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    expect(evidence[1]).toMatchObject({ ...objects[1], byteLength: 2 });
    const sameLengthCorruption = await readStorageEvidence(clientFor([Buffer.from('abd'), Buffer.from('{}')]), objects);
    expect(sameLengthCorruption[0].byteLength).toBe(evidence[0].byteLength);
    expect(sameLengthCorruption[0].sha256).not.toBe(evidence[0].sha256);
    const unrelatedCorruption = await readStorageEvidence(clientFor([Buffer.from('abc'), Buffer.from('[]')]), objects);
    expect(unrelatedCorruption[1].sha256).not.toBe(evidence[1].sha256);
    const truncated = await readStorageEvidence(clientFor([Buffer.from('ab'), Buffer.from('{}')]), objects);
    expect(truncated[0].byteLength).not.toBe(evidence[0].byteLength);
  });

  it('fails closed on missing/unreadable objects without echoing Storage error detail', async () => {
    await expect(readStorageEvidence(clientFor([null, Buffer.from('{}')]), objects))
      .rejects.toThrow('UPGRADE_STORAGE_DOWNLOAD_FAILED');
  });
});
