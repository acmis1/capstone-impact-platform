import { describe, it, expect, vi } from 'vitest';
import {
  runBrevoEmailTransportVerification,
  isAllowlistedRecipient,
} from './verifyBrevoEmailTransportRuntime';

const VALID_BREVO_ENV = {
  PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'true',
  PARTICIPANT_PREVIEW_EMAIL_PROVIDER: 'brevo',
  PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY: 'xkeysib-operator-test-key-12345',
  PARTICIPANT_PREVIEW_EMAIL_FROM: 'operator-check@capstone.internal',
};

describe('verifyBrevoEmailTransportRuntime', () => {
  describe('isAllowlistedRecipient', () => {
    it('rejects arbitrary addresses including rmit.edu.vn when not in explicit allowlist', () => {
      expect(isAllowlistedRecipient('staff@rmit.edu.vn', [], false)).toBe(false);
      expect(isAllowlistedRecipient('participant@rmit.edu.vn', [], false)).toBe(false);
      expect(isAllowlistedRecipient('random-user@gmail.com', [], false)).toBe(false);
    });

    it('permits specific email addresses provided via explicit allowlist for live sends', () => {
      const allowlist = ['team-mailbox@rmit.edu.vn', 'lead@capstone.test'];
      expect(isAllowlistedRecipient('team-mailbox@rmit.edu.vn', allowlist, false)).toBe(true);
      expect(isAllowlistedRecipient('lead@capstone.test', allowlist, false)).toBe(true);
      // Typo to another address must fail
      expect(isAllowlistedRecipient('team-mailbox2@rmit.edu.vn', allowlist, false)).toBe(false);
    });

    it('allows synthetic example domains specifically for sandbox mode where delivery is dropped', () => {
      expect(isAllowlistedRecipient('tester@example.test', [], true)).toBe(true);
      expect(isAllowlistedRecipient('system@capstone.internal', [], true)).toBe(true);
      // Even in sandbox, random public domains not allowlisted are rejected
      expect(isAllowlistedRecipient('random-user@gmail.com', [], true)).toBe(false);
    });
  });

  describe('runBrevoEmailTransportVerification safety gates', () => {
    it('blocks execution in CI environments when skipCiCheck is false', async () => {
      const result = await runBrevoEmailTransportVerification({
        env: { ...VALID_BREVO_ENV, CI: 'true' },
        args: ['--opt-in-real-send'],
      });
      expect(result.outcome).toBe('BLOCKED_IN_CI');
    });

    it('requires explicit command-line --opt-in-real-send for live sending', async () => {
      // Missing entirely
      const res1 = await runBrevoEmailTransportVerification({
        env: VALID_BREVO_ENV,
        args: [],
        skipCiCheck: true,
      });
      expect(res1.outcome).toBe('OPT_IN_REQUIRED');

      // Environment variable alone is rejected for live sends
      const res2 = await runBrevoEmailTransportVerification({
        env: { ...VALID_BREVO_ENV, BREVO_OPERATOR_VERIFICATION_OPT_IN: 'true' },
        args: [],
        skipCiCheck: true,
      });
      expect(res2.outcome).toBe('OPT_IN_REQUIRED');
    });

    it('detects missing Brevo credentials early and reports prerequisites', async () => {
      const result = await runBrevoEmailTransportVerification({
        env: { PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'true', PARTICIPANT_PREVIEW_EMAIL_PROVIDER: 'brevo' },
        args: ['--opt-in-real-send'],
        skipCiCheck: true,
      });
      expect(result.outcome).toBe('PREREQUISITES_MISSING');
      expect(result.details?.requiredVariables).toBeDefined();
    });

    it('fails closed when live recipient is missing and not allowlisted', async () => {
      const result = await runBrevoEmailTransportVerification({
        env: VALID_BREVO_ENV,
        args: ['--opt-in-real-send'],
        skipCiCheck: true,
      });
      expect(result.outcome).toBe('RECIPIENT_NOT_ALLOWLISTED');
      expect(result.message).toBe('Target recipient is not on the explicit verification allowlist.');
    });

    it('rejects arbitrary @rmit.edu.vn address when not on explicit allowlist', async () => {
      const result = await runBrevoEmailTransportVerification({
        env: VALID_BREVO_ENV,
        args: ['--opt-in-real-send', '--recipient', 'arbitrary-participant@rmit.edu.vn'],
        skipCiCheck: true,
      });
      expect(result.outcome).toBe('RECIPIENT_NOT_ALLOWLISTED');
      // Verify message does NOT echo the recipient email address
      expect(result.message).not.toContain('arbitrary-participant@rmit.edu.vn');
    });

    it('labels sandbox mode response as SANDBOX_NO_DELIVERY without exposing raw provider ID', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messageId: '<sandbox-msg-id-777>' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await runBrevoEmailTransportVerification({
        env: { ...VALID_BREVO_ENV, PARTICIPANT_PREVIEW_EMAIL_BREVO_SANDBOX: 'true' },
        args: ['--opt-in-real-send', '--recipient', 'tester@example.test'],
        fetchFn: mockFetch as unknown as typeof fetch,
        endpoint: 'https://localhost:8443/v3/smtp/email',
        skipCiCheck: true,
      });

      expect(result.outcome).toBe('SANDBOX_NO_DELIVERY');
      expect(result.referenceFingerprint).toBeDefined();
      expect(result.message).toContain('delivery dropped at provider per sandbox configuration');
      // Does not expose raw message ID in result
      expect(JSON.stringify(result)).not.toContain('<sandbox-msg-id-777>');
    });

    it('reports ACCEPTED on live provider success without leaking recipient or provider ID', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messageId: '<real-provider-msg-id-888>' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const approvedMailbox = 'team-tested@rmit.edu.vn';
      const result = await runBrevoEmailTransportVerification({
        env: {
          ...VALID_BREVO_ENV,
          BREVO_VERIFICATION_ALLOWLIST: approvedMailbox,
        },
        args: ['--opt-in-real-send', '--recipient', approvedMailbox],
        fetchFn: mockFetch as unknown as typeof fetch,
        endpoint: 'https://localhost:8443/v3/smtp/email',
        skipCiCheck: true,
      });

      expect(result.outcome).toBe('ACCEPTED');
      expect(result.referenceFingerprint).toBeDefined();
      // Output privacy: Result object JSON must not leak recipient or raw provider messageId
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(approvedMailbox);
      expect(serialized).not.toContain('<real-provider-msg-id-888>');
    });

    it('reports REJECTED on provider refusal (e.g. 429 quota exhaustion)', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Daily send quota reached' }), {
          status: 429,
        }),
      );

      const approvedMailbox = 'team-tested@rmit.edu.vn';
      const result = await runBrevoEmailTransportVerification({
        env: {
          ...VALID_BREVO_ENV,
          BREVO_VERIFICATION_ALLOWLIST: approvedMailbox,
        },
        args: ['--opt-in-real-send', '--recipient', approvedMailbox],
        fetchFn: mockFetch as unknown as typeof fetch,
        endpoint: 'https://localhost:8443/v3/smtp/email',
        skipCiCheck: true,
      });

      expect(result.outcome).toBe('REJECTED');
      expect(result.failureCode).toBe('MESSAGE_REJECTED');
    });
  });
});
