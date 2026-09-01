import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { captureRecoveryBackup } from '../recovery/captureRecoveryBackup';
import { readLinkedProjectRef } from '../recovery/supabaseRecoveryCli';
import {
  APPROVED_HOSTED_SOURCE_PROJECT_NAME,
  APPROVED_HOSTED_SOURCE_PROJECT_REF,
  RECOVERY_EVIDENCE_LABEL,
  RecoveryGuardError,
  assertApprovedHostedCaptureTarget,
} from '../recovery/zeroCostRecoveryContract';
import {
  EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT,
  EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT,
} from '../recovery/managedSchemaCustomizations';

/**
 * Phase A CLI: capture a read-only recovery bundle from the approved hosted staging origin.
 *
 * This performs no write of any kind against the source. It refuses to start unless the Supabase
 * CLI itself reports the approved linked project ref, and unless the operator has chosen a backup
 * directory outside every Git working tree.
 */

const repositoryRoot = path.resolve(__dirname, '../../../..');

interface CliOptions {
  projectRef: string;
  outputDirectory: string;
  supabaseWorkdir: string;
  environmentLabel: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run capture:recovery-backup -- \\',
    `    --project-ref=${APPROVED_HOSTED_SOURCE_PROJECT_REF} \\`,
    '    --output-dir=<absolute path outside every Git working tree>',
    '',
    'Optional:',
    '  --supabase-workdir=<dir>       Parent of supabase/ (default: repository infra/)',
    '  --environment-label=<label>    Evidence label (default: hosted-staging-v2)',
    '',
    'Requires SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in the environment for the',
    'Storage read. The value is never printed and never written into the bundle.',
  ].join('\n');
}

export function parseCaptureArgs(args: readonly string[]): CliOptions {
  const options: Partial<CliOptions> = {};
  for (const argument of args) {
    if (argument.startsWith('--project-ref=')) options.projectRef = argument.slice('--project-ref='.length);
    else if (argument.startsWith('--output-dir=')) options.outputDirectory = argument.slice('--output-dir='.length);
    else if (argument.startsWith('--supabase-workdir=')) options.supabaseWorkdir = argument.slice('--supabase-workdir='.length);
    else if (argument.startsWith('--environment-label=')) options.environmentLabel = argument.slice('--environment-label='.length);
    else throw new RecoveryGuardError('UNSUPPORTED_ARGUMENT');
  }
  if (!options.projectRef) throw new RecoveryGuardError('REQUESTED_PROJECT_REF_MISSING');
  if (!options.outputDirectory) throw new RecoveryGuardError('BACKUP_DIRECTORY_NOT_ABSOLUTE');
  const parsed = {
    projectRef: options.projectRef,
    outputDirectory: options.outputDirectory,
    supabaseWorkdir: options.supabaseWorkdir ?? path.join(repositoryRoot, 'infra'),
    environmentLabel: options.environmentLabel ?? 'hosted-staging-v2',
  };
  if (!path.isAbsolute(parsed.outputDirectory) || !path.isAbsolute(parsed.supabaseWorkdir)) {
    throw new RecoveryGuardError('BACKUP_OR_SUPABASE_DIRECTORY_NOT_ABSOLUTE');
  }
  if (!/^[a-z0-9-]{3,64}$/.test(parsed.environmentLabel)) {
    throw new RecoveryGuardError('SOURCE_ENVIRONMENT_LABEL_INVALID');
  }
  return parsed;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCaptureArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`CAPTURE_REFUSED = ${error instanceof Error ? error.message : 'ARGUMENTS_INVALID'}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-capture-'));
  try {
    // Fail closed on target identity before any network capture. A project name is never accepted.
    const projectRef = assertApprovedHostedCaptureTarget({
      requestedProjectRef: options.projectRef,
      linkedProjectRef: readLinkedProjectRef(options.supabaseWorkdir),
    });

    const storageServiceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!storageServiceKey) throw new RecoveryGuardError('SOURCE_STORAGE_CREDENTIAL_UNAVAILABLE');

    const result = await captureRecoveryBackup({
      repositoryRoot,
      target: { kind: 'hosted-linked', workdir: options.supabaseWorkdir },
      sourceKind: 'hosted-staging',
      sourceProjectRef: projectRef,
      environmentLabel: options.environmentLabel,
      outputDirectory: options.outputDirectory,
      storageApiUrl: `https://${projectRef}.supabase.co`,
      storageServiceKey,
      scratchDirectory,
    });

    const manifest = result.manifest;
    console.log(`EVIDENCE_LABEL = ${RECOVERY_EVIDENCE_LABEL}`);
    console.log('CAPTURE_CLASSIFICATION = SOURCE_CAPTURE_COMPLETE');
    console.log(`SOURCE_PROJECT = ${APPROVED_HOSTED_SOURCE_PROJECT_NAME} (${projectRef})`);
    console.log('SOURCE_MUTATIONS = NONE');
    console.log(`REVIEWED_REPOSITORY_SHA = ${manifest.source.reviewedRepositoryGitSha}`);
    console.log(`CAPTURE_STARTED_UTC = ${manifest.capture.startedAt}`);
    console.log(`CAPTURE_COMPLETED_UTC = ${manifest.capture.completedAt}`);
    console.log(`BACKUP_DURATION_MS = ${Date.parse(result.completedAt) - Date.parse(result.startedAt)}`);
    console.log(`SOURCE_POSTGRES_MAJOR = ${manifest.postgres.majorVersion}`);
    console.log(`MIGRATIONS = ${manifest.migrations.count}`);
    console.log(`LATEST_MIGRATION = ${manifest.migrations.latest}`);
    console.log(`AUTH_USER_COUNT = ${manifest.auth.userCount}`);
    console.log(`MANAGED_AUTH_CUSTOMIZATIONS = ${manifest.managedSchemaCustomizations.authCount}/${EXPECTED_MANAGED_AUTH_CUSTOMIZATION_COUNT}`);
    console.log(`MANAGED_STORAGE_CUSTOMIZATIONS = ${manifest.managedSchemaCustomizations.storageCount}/${EXPECTED_MANAGED_STORAGE_CUSTOMIZATION_COUNT}`);
    console.log('MANAGED_SCHEMA_CUSTOMIZATIONS = SOURCE_MATCH');
    console.log(`APPLICATION_TABLES_MEASURED = ${manifest.dataEvidence.tableCount}`);
    console.log(`ASSISTIVE_LAUNCH_RESERVATIONS = ${manifest.executionControl.launchReservationCount}`);
    // Bucket object keys are private; only counts, byte totals, and checksum roots are printed.
    for (const bucket of manifest.storage.buckets) {
      console.log(
        `STORAGE_BUCKET ${bucket.id} = ${bucket.objectCount} objects, ${bucket.totalBytes} bytes, `
        + `public=${bucket.public}, root=${bucket.checksumRoot.slice(0, 12)}`,
      );
    }
    console.log(`BUNDLE_DIRECTORY = ${result.bundleDirectory}`);
    console.log('BUNDLE_CLASSIFICATION = PRIVATE_RECOVERY_EVIDENCE_NEVER_COMMIT');
    console.log('NEXT_STEP = run the restore verifier against this bundle on an isolated machine path.');
  } catch (error) {
    console.error(`CAPTURE_CLASSIFICATION = SOURCE_CAPTURE_INCOMPLETE`);
    console.error(`CAPTURE_REFUSED = ${error instanceof Error ? error.message : 'CAPTURE_FAILED'}`);
    console.error(
      'FAILED_BUNDLE_HANDLING = PRIVATE_INCOMPLETE; retain or securely destroy under operator policy; never commit.',
    );
    process.exitCode = 1;
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) void main();
