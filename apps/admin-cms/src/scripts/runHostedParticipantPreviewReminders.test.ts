import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHostedParticipantPreviewReminders } from './runHostedParticipantPreviewReminders';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hosted participant preview reminder entrypoint', () => {
  it('keeps disabled SMTP non-sending without initializing a hosted database pass', async () => {
    const controller = new AbortController();
    controller.abort();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runHostedParticipantPreviewReminders({
      signal: controller.signal,
      env: {
        PARTICIPANT_PREVIEW_REMINDERS_ENABLED: 'true',
        PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'false',
      },
    })).resolves.toBe('DISABLED');

    expect(log).toHaveBeenCalledWith(expect.stringContaining('EMAIL_DELIVERY_DISABLED'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('STARTED'));
  });

  it('reports only a bounded configuration code for an enabled invalid target', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runHostedParticipantPreviewReminders({
      env: {
        CAPSTONE_RUNTIME_ENV: 'production',
        CAPSTONE_PRODUCTION_REMINDERS_ENABLED: 'true',
        CAPSTONE_PRODUCTION_REMINDERS_ACKNOWLEDGEMENT: 'production-reminders-approved',
        CAPSTONE_EXPECTED_SUPABASE_HOST: 'staging-project.supabase.co',
        PARTICIPANT_PREVIEW_REMINDERS_SUPABASE_URL: 'https://staging-project.supabase.co',
        PARTICIPANT_PREVIEW_REMINDERS_ENABLED: 'true',
        PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'true',
        PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST: 'smtp.test.invalid',
        PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT: '587',
        PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE: 'true',
        PARTICIPANT_PREVIEW_EMAIL_SMTP_USER: 'runner-test-user',
        PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD: 'runner-test-password',
        PARTICIPANT_PREVIEW_EMAIL_FROM: 'no-reply@capstone.invalid',
        SUPABASE_SECRET_KEY: 'sb_secret_runner-test',
      },
    })).resolves.toBe('CONFIGURATION_INVALID');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('TARGET_IDENTITY_INVALID'));
    expect(error.mock.calls[0]?.[0]).not.toContain('staging-project.supabase.co');
    expect(error.mock.calls[0]?.[0]).not.toContain('runner-test-password');
  });
});
