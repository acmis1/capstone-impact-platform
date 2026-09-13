import { classifySupabaseCredential } from '../lib/supabaseCredential';
import {
  isParticipantPreviewEmailEnabledValue,
  PARTICIPANT_PREVIEW_EMAIL_ENABLED_VAR,
  PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE_VAR,
  resolveParticipantPreviewEmailConfig,
  type ParticipantPreviewEmailSmtpConfig,
  type ParticipantPreviewEmailEnv,
} from '../notifications/participantPreviewEmailConfig';
import {
  isParticipantPreviewRemindersEnabledValue,
  PARTICIPANT_PREVIEW_REMINDERS_ENABLED_VAR,
} from './participantPreviewReminderConfig';
import {
  assertVerifiedProductionRuntime,
  assertVerifiedStagingRuntime,
  type StagingRuntimeEnvironment,
} from '../security/stagingRuntimeIdentity';
import { isValidMutationConfirmationLabel } from '../security/stagingExecutionGuard';
import { isProductionRemindersEnabled } from '../security/operationalProductionCapabilities';

export const PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL_VAR =
  'PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL';
export const CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF_VAR =
  'CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF';
export const CAPSTONE_STAGING_MUTATION_CONFIRMATION_VAR =
  'CAPSTONE_STAGING_MUTATION_CONFIRMATION';
export const CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT_VAR =
  'CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT';
export const PARTICIPANT_PREVIEW_REMINDERS_POLL_INTERVAL_MS_VAR =
  'PARTICIPANT_PREVIEW_REMINDERS_POLL_INTERVAL_MS';
export const PARTICIPANT_PREVIEW_REMINDERS_BATCH_LIMIT_VAR =
  'PARTICIPANT_PREVIEW_REMINDERS_BATCH_LIMIT';

export const DEFAULT_HOSTED_PARTICIPANT_PREVIEW_REMINDER_POLL_INTERVAL_MS = 60_000;
export const MIN_HOSTED_PARTICIPANT_PREVIEW_REMINDER_POLL_INTERVAL_MS = 5_000;
export const MAX_HOSTED_PARTICIPANT_PREVIEW_REMINDER_POLL_INTERVAL_MS = 900_000;
export const DEFAULT_HOSTED_PARTICIPANT_PREVIEW_REMINDER_BATCH_LIMIT = 20;

export type HostedParticipantPreviewReminderEnvironment =
  StagingRuntimeEnvironment & ParticipantPreviewEmailEnv;

export type HostedParticipantPreviewReminderDisabledReason =
  | 'REMINDERS_DISABLED'
  | 'EMAIL_DELIVERY_DISABLED';

export type HostedParticipantPreviewReminderInvalidReason =
  | 'EMAIL_CONFIGURATION_INCOMPLETE'
  | 'PRODUCTION_CAPABILITY_DISABLED'
  | 'TARGET_IDENTITY_INVALID'
  | 'MUTATION_CONFIRMATION_INVALID'
  | 'SUPABASE_CREDENTIAL_INVALID'
  | 'POLL_INTERVAL_INVALID'
  | 'BATCH_LIMIT_INVALID';

export type HostedParticipantPreviewReminderConfigResult =
  | {
      state: 'DISABLED';
      reason: HostedParticipantPreviewReminderDisabledReason;
      pollIntervalMs: number;
    }
  | {
      state: 'CONFIGURATION_INVALID';
      reason: HostedParticipantPreviewReminderInvalidReason;
    }
  | {
      state: 'READY';
      supabaseUrl: string;
      supabaseSecretKey: string;
      smtp: ParticipantPreviewEmailSmtpConfig;
      fromAddress: string;
      pollIntervalMs: number;
      batchLimit: number;
    };

function disabled(
  reason: HostedParticipantPreviewReminderDisabledReason,
): HostedParticipantPreviewReminderConfigResult {
  return {
    state: 'DISABLED',
    reason,
    pollIntervalMs: DEFAULT_HOSTED_PARTICIPANT_PREVIEW_REMINDER_POLL_INTERVAL_MS,
  };
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return null;
  return value;
}

function isSameSupabaseBaseUrl(left: string, right: string): boolean {
  try {
    const first = new URL(left);
    const second = new URL(right);
    const isCanonicalBase = (value: URL) =>
      value.protocol === 'https:' &&
      value.username === '' &&
      value.password === '' &&
      value.port === '' &&
      (value.pathname === '' || value.pathname === '/') &&
      value.search === '' &&
      value.hash === '';
    return isCanonicalBase(first) && isCanonicalBase(second) && first.origin === second.origin;
  } catch {
    return false;
  }
}

function targetIdentityIsUnambiguous(
  env: HostedParticipantPreviewReminderEnvironment,
  supabaseUrl: string,
): boolean {
  const expectedProjectRef = env[CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF_VAR];
  if (
    !expectedProjectRef ||
    expectedProjectRef !== expectedProjectRef.trim() ||
    !/^[a-z]{20}$/.test(expectedProjectRef)
  ) {
    return false;
  }

  try {
    const target = new URL(supabaseUrl);
    if (target.hostname !== `${expectedProjectRef}.supabase.co`) return false;
  } catch {
    return false;
  }

  for (const configuredUrl of [
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.CAPSTONE_ASSISTIVE_SUPABASE_URL,
  ]) {
    if (configuredUrl !== undefined && !isSameSupabaseBaseUrl(supabaseUrl, configuredUrl)) {
      return false;
    }
  }

  try {
    const runtimeEnv = { ...env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl };
    if (env.CAPSTONE_RUNTIME_ENV === 'production') {
      assertVerifiedProductionRuntime(runtimeEnv);
    } else {
      assertVerifiedStagingRuntime(runtimeEnv);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the hosted runner's complete side-effect boundary.
 *
 * Disabled email is an idle, non-sending state. Any configuration that would permit sending but
 * is incomplete or targets an unverified environment is an invalid state. Neither state returns a
 * database credential or SMTP configuration to the caller.
 */
export function resolveHostedParticipantPreviewReminderConfig(
  env: HostedParticipantPreviewReminderEnvironment = process.env,
): HostedParticipantPreviewReminderConfigResult {
  if (!isParticipantPreviewRemindersEnabledValue(env[PARTICIPANT_PREVIEW_REMINDERS_ENABLED_VAR])) {
    return disabled('REMINDERS_DISABLED');
  }

  if (!isParticipantPreviewEmailEnabledValue(env[PARTICIPANT_PREVIEW_EMAIL_ENABLED_VAR])) {
    return disabled('EMAIL_DELIVERY_DISABLED');
  }

  const production = env.CAPSTONE_RUNTIME_ENV === 'production';
  if (production && !isProductionRemindersEnabled(env)) {
    return { state: 'CONFIGURATION_INVALID', reason: 'PRODUCTION_CAPABILITY_DISABLED' };
  }

  const secureFlag = env[PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE_VAR]?.trim().toLowerCase();
  if (secureFlag !== 'true' && secureFlag !== 'false') {
    return { state: 'CONFIGURATION_INVALID', reason: 'EMAIL_CONFIGURATION_INCOMPLETE' };
  }

  const email = resolveParticipantPreviewEmailConfig(env);
  if (!email.enabled) {
    return { state: 'CONFIGURATION_INVALID', reason: 'EMAIL_CONFIGURATION_INCOMPLETE' };
  }

  const pollIntervalMs = boundedInteger(
    env[PARTICIPANT_PREVIEW_REMINDERS_POLL_INTERVAL_MS_VAR],
    DEFAULT_HOSTED_PARTICIPANT_PREVIEW_REMINDER_POLL_INTERVAL_MS,
    MIN_HOSTED_PARTICIPANT_PREVIEW_REMINDER_POLL_INTERVAL_MS,
    MAX_HOSTED_PARTICIPANT_PREVIEW_REMINDER_POLL_INTERVAL_MS,
  );
  if (pollIntervalMs === null) {
    return { state: 'CONFIGURATION_INVALID', reason: 'POLL_INTERVAL_INVALID' };
  }

  const batchLimit = boundedInteger(
    env[PARTICIPANT_PREVIEW_REMINDERS_BATCH_LIMIT_VAR],
    DEFAULT_HOSTED_PARTICIPANT_PREVIEW_REMINDER_BATCH_LIMIT,
    1,
    50,
  );
  if (batchLimit === null) {
    return { state: 'CONFIGURATION_INVALID', reason: 'BATCH_LIMIT_INVALID' };
  }

  const supabaseUrl = env[PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL_VAR];
  if (
    !supabaseUrl ||
    supabaseUrl !== supabaseUrl.trim() ||
    !targetIdentityIsUnambiguous(env, supabaseUrl)
  ) {
    return { state: 'CONFIGURATION_INVALID', reason: 'TARGET_IDENTITY_INVALID' };
  }

  // This is an operator acknowledgment label, not cryptographic proof of target identity.
  const mutationConfirmation = production
    ? env[CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT_VAR]
    : env[CAPSTONE_STAGING_MUTATION_CONFIRMATION_VAR];
  if (!mutationConfirmation || !isValidMutationConfirmationLabel(mutationConfirmation)) {
    return { state: 'CONFIGURATION_INVALID', reason: 'MUTATION_CONFIRMATION_INVALID' };
  }

  const secretKey = env.SUPABASE_SECRET_KEY;
  if (
    !secretKey ||
    classifySupabaseCredential(secretKey, true) !== 'secret' ||
    Boolean(env.SUPABASE_SERVICE_ROLE_KEY?.trim())
  ) {
    return { state: 'CONFIGURATION_INVALID', reason: 'SUPABASE_CREDENTIAL_INVALID' };
  }

  return {
    state: 'READY',
    supabaseUrl,
    supabaseSecretKey: secretKey,
    smtp: { ...email.smtp, requireTLS: true },
    fromAddress: email.smtp.from,
    pollIntervalMs,
    batchLimit,
  };
}
