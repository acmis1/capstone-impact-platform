import { createClient } from '@supabase/supabase-js';

import { SupabaseAssistiveExecutionControlRepository } from '../assistive-validation/repositories/assistiveExecutionControlRepository';
import {
  executorRegistrationResponseSchema,
  EXECUTOR_REGISTRATION_DAYS,
} from '../assistive-validation/domain/executionControlContract';
import { classifySupabaseCredential } from '../lib/supabaseCredential';
import { assertVerifiedStagingRuntime } from '../security/stagingRuntimeIdentity';

/**
 * Operator command run once per executor deployment.
 *
 * Registration is what lets Admin truthfully report on-demand availability before the executor has
 * ever run, and it is the identity the dispatcher and the worker are both checked against. It
 * creates no execution and consumes no launch capacity.
 *
 * Usage:
 *   npm run register:assistive-executor --workspace=apps/admin-cms -- \
 *     --deployment-version=<40-hex commit> \
 *     --image-digest=sha256:<64 hex> \
 *     --configuration-version=<slug>
 */

function argument(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (!found) throw new Error(`Missing required argument: --${name}`);
  return found.slice(prefix.length).trim();
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.CAPSTONE_ASSISTIVE_SUPABASE_URL?.trim();
  if (!supabaseUrl) throw new Error('CAPSTONE_ASSISTIVE_SUPABASE_URL is required.');
  assertVerifiedStagingRuntime({ ...process.env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl });

  const secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!secret || classifySupabaseCredential(secret, true) !== 'secret') {
    throw new Error('An approved server secret key is required.');
  }

  const deploymentVersion = argument('deployment-version').toLowerCase();
  const imageDigest = argument('image-digest').toLowerCase();
  const configurationVersion = argument('configuration-version');

  const control = new SupabaseAssistiveExecutionControlRepository(
    createClient(supabaseUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } }),
  );
  const parsed = executorRegistrationResponseSchema.parse(await control.register({
    deploymentVersion,
    imageDigest,
    configurationVersion,
  }));

  if (parsed.resultCode !== 'REGISTERED') {
    throw new Error('Executor registration was rejected. Check the deployment, image, and configuration identities.');
  }
  console.log(JSON.stringify({
    schemaVersion: 'assistive-executor-registration/v1',
    resultCode: parsed.resultCode,
    deploymentVersion: parsed.deploymentVersion,
    imageDigest: parsed.imageDigest,
    expiresAt: parsed.expiresAt,
    registrationDays: EXECUTOR_REGISTRATION_DAYS,
  }, null, 2));
}

void main().catch((error) => {
  console.error(`[Assistive executor registration] ${error instanceof Error ? error.message : 'FAILED'}`);
  process.exitCode = 1;
});
