import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const runnerPath = path.resolve(__dirname, 'runDisposableLedgerRuntime.ts');
const migrationsPath = path.resolve(__dirname, '../../../../infra/supabase/migrations');
const runnerSource = fs.readFileSync(runnerPath, 'utf8').replace(/\r\n/g, '\n');
const migrationInventory = fs.readdirSync(migrationsPath)
  .filter((name) => name.endsWith('.sql'))
  .sort();

function declaredNumber(name: string): number {
  const match = runnerSource.match(new RegExp(`const ${name} = (\\d+);`));
  if (!match) throw new Error(`Missing ${name}`);
  return Number(match[1]);
}

function declaredCorrectionMigrations(): string[] {
  const block = runnerSource.match(/const CORRECTION_MIGRATIONS = \[(.*?)\];/s)?.[1];
  if (!block) throw new Error('Missing CORRECTION_MIGRATIONS');
  return [...block.matchAll(/'([^']+\.sql)'/g)].map((match) => match[1]);
}

describe('disposable ledger migration inventory contract', () => {
  it('matches the declared release tail and current migration head without importing the runner', () => {
    const preCorrectionCount = declaredNumber('PRE_CORRECTION_MIGRATION_COUNT');
    const currentHeadCount = declaredNumber('CURRENT_MAIN_MIGRATION_COUNT');
    const correctionMigrations = declaredCorrectionMigrations();

    expect(preCorrectionCount).toBe(51);
    expect(correctionMigrations).toEqual(migrationInventory.slice(preCorrectionCount));
    expect(correctionMigrations.length).toBe(migrationInventory.length - preCorrectionCount);
    expect(currentHeadCount).toBe(migrationInventory.length);
  });
});
