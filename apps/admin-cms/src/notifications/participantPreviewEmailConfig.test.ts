import { describe, it, expect } from 'vitest';
import {
  isParticipantPreviewEmailEnabled,
  isParticipantPreviewEmailEnabledValue,
  resolveParticipantPreviewEmailConfig,
} from './participantPreviewEmailConfig';

const COMPLETE = {
  PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'true',
  PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST: '127.0.0.1',
  PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT: '54325',
  PARTICIPANT_PREVIEW_EMAIL_FROM: 'no-reply@capstone.invalid',
};

describe('participant preview email enablement', () => {
  it('treats only the exact string "true" as enabled', () => {
    for (const value of ['true', 'TRUE', ' True ']) {
      expect(isParticipantPreviewEmailEnabledValue(value)).toBe(true);
    }
    for (const value of ['false', '1', 'yes', 'on', '', undefined, null]) {
      expect(isParticipantPreviewEmailEnabledValue(value)).toBe(false);
    }
  });

  it('is disabled when nothing is configured at all', () => {
    expect(resolveParticipantPreviewEmailConfig({})).toEqual({ enabled: false });
    expect(isParticipantPreviewEmailEnabled({})).toBe(false);
  });

  it('is disabled when the flag is set but transport configuration is missing', () => {
    expect(
      resolveParticipantPreviewEmailConfig({ PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'true' }),
    ).toEqual({ enabled: false });
  });

  it('is disabled when the flag is absent even with complete transport configuration', () => {
    const env = { ...COMPLETE, PARTICIPANT_PREVIEW_EMAIL_ENABLED: undefined };
    expect(resolveParticipantPreviewEmailConfig(env)).toEqual({ enabled: false });
  });

  it('resolves a complete anonymous configuration', () => {
    const result = resolveParticipantPreviewEmailConfig(COMPLETE);
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled configuration');
    expect(result.smtp).toEqual({
      host: '127.0.0.1',
      port: 54325,
      secure: false,
      auth: null,
      from: 'no-reply@capstone.invalid',
    });
  });

  it('requires a username and password together, never one alone', () => {
    expect(
      resolveParticipantPreviewEmailConfig({
        ...COMPLETE,
        PARTICIPANT_PREVIEW_EMAIL_SMTP_USER: 'mailer',
      }),
    ).toEqual({ enabled: false });

    const result = resolveParticipantPreviewEmailConfig({
      ...COMPLETE,
      PARTICIPANT_PREVIEW_EMAIL_SMTP_USER: 'mailer',
      PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD: 'secret',
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) throw new Error('expected enabled configuration');
    expect(result.smtp.auth).toEqual({ user: 'mailer', password: 'secret' });
  });

  it('rejects an out-of-range or non-numeric port rather than guessing one', () => {
    for (const port of ['0', '70000', 'abc', '', '  ']) {
      expect(
        resolveParticipantPreviewEmailConfig({
          ...COMPLETE,
          PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT: port,
        }),
      ).toEqual({ enabled: false });
    }
  });

  it('rejects host and From values carrying control characters', () => {
    const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
    expect(
      resolveParticipantPreviewEmailConfig({
        ...COMPLETE,
        PARTICIPANT_PREVIEW_EMAIL_FROM: `no-reply@capstone.invalid${CRLF}Bcc: attacker@evil.test`,
      }),
    ).toEqual({ enabled: false });
    expect(
      resolveParticipantPreviewEmailConfig({
        ...COMPLETE,
        PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST: `127.0.0.1${CRLF}evil`,
      }),
    ).toEqual({ enabled: false });
  });
});
