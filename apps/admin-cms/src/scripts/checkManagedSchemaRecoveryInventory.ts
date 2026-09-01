import fs from 'node:fs';
import path from 'node:path';
import {
  assertRepositoryManagedSchemaMigrationInventory,
  EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT,
  EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT,
  inspectRepositoryManagedSchemaMigrationInventory,
  REPOSITORY_MANAGED_SCHEMA_EXPECTATION,
} from '../recovery/managedSchemaCustomizations';

const repositoryRoot = path.resolve(__dirname, '../../../..');

function main(): void {
  try {
    assertRepositoryManagedSchemaMigrationInventory(repositoryRoot);
    const operations = inspectRepositoryManagedSchemaMigrationInventory(repositoryRoot);
    console.log('MANAGED_SCHEMA_MIGRATION_INVENTORY = MATCH');
    console.log(`MIGRATION_FILES_INSPECTED = ${repositoryMigrationCount()}`);
    console.log(`MANAGED_AUTH_CUSTOMIZATIONS = ${EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT}/${EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT}`);
    console.log(`MANAGED_STORAGE_CUSTOMIZATIONS = ${EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT}/${EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT}`);
    for (const trigger of REPOSITORY_MANAGED_SCHEMA_EXPECTATION.triggers) {
      console.log(`MANAGED_TRIGGER = ${trigger.schema}.${trigger.table}.${trigger.name}`);
    }
    console.log(`MANAGED_SCHEMA_MIGRATION_OPERATIONS = ${operations.length}`);
  } catch (error) {
    console.error('MANAGED_SCHEMA_MIGRATION_INVENTORY = REVIEW_REQUIRED');
    console.error(`FINDING = ${error instanceof Error ? error.message : 'UNKNOWN'}`);
    process.exitCode = 1;
  }
}

function repositoryMigrationCount(): number {
  return fs.readdirSync(
    path.join(repositoryRoot, 'infra', 'supabase', 'migrations'),
  ).filter((file: string) => file.endsWith('.sql')).length;
}

main();
