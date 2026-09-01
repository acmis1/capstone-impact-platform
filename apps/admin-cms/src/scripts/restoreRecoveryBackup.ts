import path from 'node:path';
import {
  assertBundlePreserved,
  DEFAULT_RESTORE_PORT_BASE,
  DEFAULT_RESTORE_POSTGRES_MAJOR_VERSION,
  runRestoreVerification,
  type RestoreVerificationResult,
} from '../recovery/restoreRecoveryRehearsal';
import { RecoveryGuardError } from '../recovery/zeroCostRecoveryContract';

const repositoryRoot = path.resolve(__dirname, '../../../..');

interface CliOptions {
  bundleDirectory: string;
  portBase: number;
  applicationPort: number;
  skipApplicationSmoke: boolean;
  targetPostgresMajorVersion: number;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run restore:recovery-backup -- --bundle-dir=<absolute private bundle path>',
    '',
    'Optional:',
    `  --port-base=<port>                 Disposable Supabase block (default: ${DEFAULT_RESTORE_PORT_BASE})`,
    '  --application-port=<port>          Disposable Admin/CMS smoke port (default: 3017)',
    `  --target-postgres-major=<15|17>    Restore engine (default: ${DEFAULT_RESTORE_POSTGRES_MAJOR_VERSION})`,
    '  --skip-application-smoke           Database, Storage and Gate 4 only',
  ].join('\n');
}

function parsePort(value: string, code: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_527) {
    throw new RecoveryGuardError(code);
  }
  return parsed;
}

export function parseRestoreArgs(args: readonly string[]): CliOptions {
  let bundleDirectory = '';
  let portBase = DEFAULT_RESTORE_PORT_BASE;
  let applicationPort = 3_017;
  let skipApplicationSmoke = false;
  let targetPostgresMajorVersion = DEFAULT_RESTORE_POSTGRES_MAJOR_VERSION;
  for (const argument of args) {
    if (argument.startsWith('--bundle-dir=')) bundleDirectory = argument.slice('--bundle-dir='.length);
    else if (argument.startsWith('--port-base=')) {
      portBase = parsePort(argument.slice('--port-base='.length), 'RESTORE_PORT_BASE_INVALID');
    } else if (argument.startsWith('--application-port=')) {
      applicationPort = parsePort(argument.slice('--application-port='.length), 'APPLICATION_PORT_INVALID');
    } else if (argument.startsWith('--target-postgres-major=')) {
      targetPostgresMajorVersion = Number.parseInt(argument.slice('--target-postgres-major='.length), 10);
      if (![15, 17].includes(targetPostgresMajorVersion)) {
        throw new RecoveryGuardError('RESTORE_POSTGRES_MAJOR_UNSUPPORTED');
      }
    } else if (argument === '--skip-application-smoke') skipApplicationSmoke = true;
    else throw new RecoveryGuardError('UNSUPPORTED_ARGUMENT');
  }
  if (!bundleDirectory || !path.isAbsolute(bundleDirectory)) {
    throw new RecoveryGuardError('BACKUP_DIRECTORY_NOT_ABSOLUTE');
  }
  return {
    bundleDirectory,
    portBase,
    applicationPort,
    skipApplicationSmoke,
    targetPostgresMajorVersion,
  };
}

export function formatRestoreSummary(result: RestoreVerificationResult, bundlePreserved: boolean): string {
  const gate4Expected = result.gate4?.expectedStats;
  const lines = [
    `RECOVERY_CLASSIFICATION = ${result.classification}`,
    `SOURCE_POSTGRES_MAJOR = ${result.sourcePostgresMajorVersion}`,
    `RESTORED_POSTGRES_MAJOR = ${result.restoredPostgresMajorVersion}`,
    `MIGRATIONS = ${result.migrationCount}`,
    `LATEST_MIGRATION = ${result.latestMigration}`,
    `PUBLIC_APPLICATION_TABLES = ${result.publicApplicationTables}`,
    `EXECUTION_CONTROL_TABLES = ${result.executionControlTables}`,
    `DATABASE_INTEGRITY_MATCH = ${result.databaseIntegrityMatch ? 'YES' : 'NO'}`,
    `STORAGE_INTEGRITY_MATCH = ${result.storageIntegrityMatch ? 'YES' : 'NO'}`,
    `ASSISTIVE_COST_FENCE_MATCH = ${result.assistiveCostFenceMatch ? 'YES' : 'NO'}`,
    `AUTH_SOURCE_COUNT = ${result.sourceAuthUserCount}`,
    `AUTH_RESTORED_COUNT = ${result.restoredAuthUserCount}`,
    `AUTH_COUNT_MATCH = ${result.authCountMatch ? 'YES' : 'NO'}`,
    `AUTH_ORPHAN_IDENTITY_COUNT = ${result.restoredAuthOrphanIdentityCount}`,
    `MANAGED_AUTH_CUSTOMIZATIONS = ${result.managedAuthCustomizationCount}/${result.expectedManagedAuthCustomizationCount}`,
    `MANAGED_STORAGE_CUSTOMIZATIONS = ${result.managedStorageCustomizationCount}/${result.expectedManagedStorageCustomizationCount}`,
    `MANAGED_SCHEMA_CUSTOMIZATIONS = ${result.managedSchemaCustomizationsMatch ? 'MATCH' : 'DRIFT'}`,
    `MANAGED_AUTH_BEHAVIOR = ${result.managedAuthBehaviorVerified === null
      ? 'NOT_RUN'
      : result.managedAuthBehaviorVerified ? 'PASS' : 'FAIL'}`,
    `STORAGE_OBJECT_COUNT = ${result.storageObjectCount}`,
    `GATE4_SELF_CHECK = ${result.gate4?.selfCheckClassification ?? 'NOT_RUN'}`,
    `GATE4_SOURCE_COMPARISON = ${result.gate4?.sourceComparisonClassification ?? 'NOT_RUN'}`,
    `GATE4_CROSS_ENGINE_PORTABILITY_NORMALIZATION = ${result.gate4?.crossEnginePortabilityNormalization ? 'YES' : 'NO'}`,
    `GATE4_MIGRATIONS = ${gate4Expected?.migrations ?? 0}`,
    `GATE4_TABLES = ${gate4Expected?.tables ?? 0}`,
    `GATE4_RPC_SIGNATURES = ${gate4Expected?.applicationRpcSignatures ?? 0}`,
    `GATE4_RPC_NAMES = ${gate4Expected?.applicationRpcNames ?? 0}`,
    `GATE4_DISPATCHER_ROUTINES = ${gate4Expected?.dispatcherControlRoutines ?? 0}`,
    `GATE4_STORAGE_BUCKETS = ${gate4Expected?.storageBuckets ?? 0}`,
    `BACKUP_AGE_AT_RESTORE_START_MS = ${result.backupAgeAtRestoreStartMs}`,
    `ZERO_COST_ISOLATED_RESTORE_DURATION_MS = ${result.restoreDurationMs}`,
    `FULL_RECOVERY_VERIFICATION_DURATION_MS = ${result.verificationDurationMs}`,
    `APPLICATION_SMOKE_HEALTH = ${result.applicationSmoke.healthStatus ?? 'NOT_RUN'}`,
    `APPLICATION_SMOKE_LOGIN = ${result.applicationSmoke.loginStatus ?? 'NOT_RUN'}`,
    `APPLICATION_SMOKE_READINESS = ${result.applicationSmoke.readinessClassification ?? 'NOT_RUN'}`,
    `DISPOSABLE_RESIDUE_ABSENT = ${result.residueAbsent ? 'YES' : 'NO'}`,
    `SUCCESSFUL_BUNDLE_PRESERVED = ${bundlePreserved ? 'YES' : 'NO'}`,
  ];
  for (const summary of result.bucketSummaries) lines.push(`STORAGE_BUCKET = ${summary}`);
  for (const difference of result.gate4?.differences ?? []) lines.push(`GATE4_DIFFERENCE = ${difference}`);
  for (const finding of result.findings.slice(0, 20)) lines.push(`FINDING = ${finding}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseRestoreArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`RESTORE_REFUSED = ${error instanceof Error ? error.message : 'ARGUMENTS_INVALID'}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runRestoreVerification({
      repositoryRoot,
      bundleDirectory: options.bundleDirectory,
      portBase: options.portBase,
      applicationPort: options.applicationPort,
      skipApplicationSmoke: options.skipApplicationSmoke,
      targetPostgresMajorVersion: options.targetPostgresMajorVersion,
    });
    const preserved = assertBundlePreserved(options.bundleDirectory);
    console.log(formatRestoreSummary(result, preserved));
    if (result.classification !== 'ZERO_COST_RECOVERY_REHEARSAL_VERIFIED' || !preserved) {
      process.exitCode = 1;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'RESTORE_FAILED';
    const classification = error instanceof RecoveryGuardError
      && (code.startsWith('RECOVERY_BUNDLE') || code.startsWith('BACKUP_DIRECTORY'))
      ? 'RECOVERY_BUNDLE_INVALID'
      : 'RESTORE_FAILED';
    console.error(`RECOVERY_CLASSIFICATION = ${classification}`);
    console.error(`RESTORE_REFUSED = ${code}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
