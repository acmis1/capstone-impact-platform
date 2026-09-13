import { describe, expect, it } from 'vitest';
import {
  resolveHostedParticipantPreviewReminderConfig,
  type HostedParticipantPreviewReminderEnvironment,
} from './hostedParticipantPreviewReminderConfig';

const VALID: HostedParticipantPreviewReminderEnvironment = {
  CAPSTONE_RUNTIME_ENV: 'staging',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'abcdefghijklmnopqrst.supabase.co',
  CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  CAPSTONE_STAGING_MUTATION_CONFIRMATION: 'capstone-admin-cms-staging-v2-2026',
  PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  PARTICIPANT_PREVIEW_REMINDERS_ENABLED: 'true',
  PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'true',
  PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST: 'smtp.test.invalid',
  PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT: '587',
  PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE: 'true',
  PARTICIPANT_PREVIEW_EMAIL_SMTP_USER: 'runner-test-user',
  PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD: 'runner-test-password',
  PARTICIPANT_PREVIEW_EMAIL_FROM: 'no-reply@capstone.invalid',
  SUPABASE_SECRET_KEY: 'sb_secret_runner-test',
};

const PRODUCTION: HostedParticipantPreviewReminderEnvironment = {
  ...VALID,
  CAPSTONE_RUNTIME_ENV: 'production',
  CAPSTONE_PRODUCTION_REMINDERS_ENABLED: 'true',
  CAPSTONE_EXPECTED_SUPABASE_HOST: 'zyxwvutsrqponmlkjihg.supabase.co',
  CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF: 'zyxwvutsrqponmlkjihg',
  CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT: 'production-preview-reminders-approved',
  CAPSTONE_STAGING_MUTATION_CONFIRMATION: undefined,
  PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://zyxwvutsrqponmlkjihg.supabase.co',
};

describe('hosted participant preview reminder configuration', () => {
  it('accepts the complete exact staging target and bounded defaults', () => {
    expect(resolveHostedParticipantPreviewReminderConfig(VALID)).toMatchObject({
      state: 'READY',
      supabaseUrl: VALID.PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL,
      smtp: expect.objectContaining({ secure: true, requireTLS: true }),
      pollIntervalMs: 60_000,
      batchLimit: 20,
    });
  });

  it('accepts the complete explicitly enabled verified production target', () => {
    expect(resolveHostedParticipantPreviewReminderConfig(PRODUCTION)).toMatchObject({
      state: 'READY',
      supabaseUrl: PRODUCTION.PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL,
      smtp: expect.objectContaining({ requireTLS: true }),
      pollIntervalMs: 60_000,
      batchLimit: 20,
    });
  });

  it.each([undefined, 'false', 'TRUE', ' true '])(
    'rejects production when its capability flag is %s',
    (flag) => {
      expect(resolveHostedParticipantPreviewReminderConfig({
        ...PRODUCTION,
        CAPSTONE_PRODUCTION_REMINDERS_ENABLED: flag,
      })).toEqual({
        state: 'CONFIGURATION_INVALID',
        reason: 'PRODUCTION_CAPABILITY_DISABLED',
      });
    },
  );

  it('requires the production-specific operator acknowledgement and never accepts the staging label', () => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...PRODUCTION,
      CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT: undefined,
      CAPSTONE_STAGING_MUTATION_CONFIRMATION: VALID.CAPSTONE_STAGING_MUTATION_CONFIRMATION,
    })).toEqual({
      state: 'CONFIGURATION_INVALID',
      reason: 'MUTATION_CONFIRMATION_INVALID',
    });
  });

  it('accepts an equivalent trailing-slash target without treating it as ambiguous', () => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...VALID,
      PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: `${VALID.PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL}/`,
    }).state).toBe('READY');
  });

  it('stays idle and non-sending when reminders are disabled before checking other values', () => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      PARTICIPANT_PREVIEW_REMINDERS_ENABLED: 'false',
    })).toEqual({
      state: 'DISABLED',
      reason: 'REMINDERS_DISABLED',
      pollIntervalMs: 60_000,
    });
  });

  it('stays idle and non-sending when SMTP delivery is disabled', () => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...VALID,
      PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'false',
      PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: undefined,
      SUPABASE_SECRET_KEY: undefined,
    })).toMatchObject({
      state: 'DISABLED',
      reason: 'EMAIL_DELIVERY_DISABLED',
    });
  });

  it('rejects an enabled but incomplete SMTP configuration before any target is usable', () => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...VALID,
      PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD: undefined,
    })).toEqual({
      state: 'CONFIGURATION_INVALID',
      reason: 'EMAIL_CONFIGURATION_INCOMPLETE',
    });
  });

  it('requires the SMTP secure transport choice to be explicit', () => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...VALID,
      PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE: undefined,
    })).toEqual({
      state: 'CONFIGURATION_INVALID',
      reason: 'EMAIL_CONFIGURATION_INCOMPLETE',
    });
  });

  it('allows institutional port 587 STARTTLS but marks hosted transport as TLS-required', () => {
    const result = resolveHostedParticipantPreviewReminderConfig({
      ...VALID,
      PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT: '587',
      PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE: 'false',
    });

    expect(result).toMatchObject({
      state: 'READY',
      smtp: { port: 587, secure: false, requireTLS: true },
    });
  });

  it.each([
    ['unknown runtime', { CAPSTONE_RUNTIME_ENV: 'preview' }],
    ['lookalike host relabelling', {
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'abcdefghijklmnopqrst.supabase.co.attacker.example',
      PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co.attacker.example',
    }],
    ['arbitrary host relabelling', {
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'zyxwvutsrqponmlkjihg.supabase.co',
      PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://zyxwvutsrqponmlkjihg.supabase.co',
    }],
    ['loopback URL', {
      CAPSTONE_EXPECTED_SUPABASE_HOST: '127.0.0.1',
      PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'http://127.0.0.1:54321',
    }],
    ['mismatched expected host', {
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'other-project.supabase.co',
    }],
    ['conflicting public URL', {
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    }],
    ['conflicting worker target alias', {
      CAPSTONE_ASSISTIVE_SUPABASE_URL: 'https://other-project.supabase.co',
    }],
    ['missing private URL', { PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: undefined }],
  ])('rejects %s without creating a send-capable configuration', (_label, override) => {
    expect(resolveHostedParticipantPreviewReminderConfig({ ...VALID, ...override })).toEqual({
      state: 'CONFIGURATION_INVALID',
      reason: 'TARGET_IDENTITY_INVALID',
    });
  });

  it('rejects a missing or malformed hosted mutation confirmation', () => {
    for (const confirmation of [undefined, '', 'CAPSTONE STAGING']) {
      expect(resolveHostedParticipantPreviewReminderConfig({
        ...VALID,
        CAPSTONE_STAGING_MUTATION_CONFIRMATION: confirmation,
      })).toEqual({
        state: 'CONFIGURATION_INVALID',
        reason: 'MUTATION_CONFIRMATION_INVALID',
      });
    }
  });

  it('rejects a target whose host ref disagrees with the independent expected project ref', () => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...VALID,
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'zyxwvutsrqponmlkjihg.supabase.co',
      PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://zyxwvutsrqponmlkjihg.supabase.co',
    })).toEqual({
      state: 'CONFIGURATION_INVALID',
      reason: 'TARGET_IDENTITY_INVALID',
    });
  });

  it.each([
    ['mismatched production host', { CAPSTONE_EXPECTED_SUPABASE_HOST: 'abcdefghijklmnopqrst.supabase.co' }],
    ['mismatched production ref', { CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' }],
    ['production path', { PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://zyxwvutsrqponmlkjihg.supabase.co/rest' }],
    ['production credentials', { PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://user:pass@zyxwvutsrqponmlkjihg.supabase.co' }],
    ['production loopback', {
      CAPSTONE_EXPECTED_SUPABASE_HOST: 'localhost',
      CAPSTONE_EXPECTED_SUPABASE_PROJECT_REF: 'zyxwvutsrqponmlkjihg',
      PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://localhost',
    }],
  ])('rejects %s', (_label, override) => {
    expect(resolveHostedParticipantPreviewReminderConfig({ ...PRODUCTION, ...override })).toEqual({
      state: 'CONFIGURATION_INVALID',
      reason: 'TARGET_IDENTITY_INVALID',
    });
  });

  it('rejects a non-secret production database credential', () => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...PRODUCTION,
      SUPABASE_SECRET_KEY: 'sb_publishable_browser-test',
    })).toEqual({
      state: 'CONFIGURATION_INVALID',
      reason: 'SUPABASE_CREDENTIAL_INVALID',
    });
  });

  it.each([
    ['missing secret', { SUPABASE_SECRET_KEY: undefined }],
    ['publishable key', { SUPABASE_SECRET_KEY: 'sb_publishable_not-a-server-key' }],
    ['legacy key alongside modern key', {
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-test-only',
    }],
  ])('rejects %s without exposing the credential', (_label, override) => {
    expect(resolveHostedParticipantPreviewReminderConfig({ ...VALID, ...override })).toEqual({
      state: 'CONFIGURATION_INVALID',
      reason: 'SUPABASE_CREDENTIAL_INVALID',
    });
  });

  it.each([
    ['too short', '4999'],
    ['too long', '900001'],
    ['not an integer', '5.5'],
  ])('rejects a %s polling interval', (_label, value) => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...VALID,
      PARTICIPANT_PREVIEW_REMINDERS_POLL_INTERVAL_MS: value,
    })).toEqual({ state: 'CONFIGURATION_INVALID', reason: 'POLL_INTERVAL_INVALID' });
  });

  it.each(['0', '51', '1.5'])('rejects an out-of-bound batch limit %s', (value) => {
    expect(resolveHostedParticipantPreviewReminderConfig({
      ...VALID,
      PARTICIPANT_PREVIEW_REMINDERS_BATCH_LIMIT: value,
    })).toEqual({ state: 'CONFIGURATION_INVALID', reason: 'BATCH_LIMIT_INVALID' });
  });
});
