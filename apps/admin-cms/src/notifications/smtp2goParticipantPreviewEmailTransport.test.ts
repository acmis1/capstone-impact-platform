import { describe, expect, it, vi } from 'vitest';
import {
  SMTP2GO_TRANSACTIONAL_EMAIL_ENDPOINT,
  Smtp2goParticipantPreviewEmailTransport,
} from './smtp2goParticipantPreviewEmailTransport';
import type { ParticipantPreviewEmailMessage } from './participantPreviewEmailTransport';

const SAMPLE_MESSAGE: ParticipantPreviewEmailMessage = {
  recipient: 'participant@example.test',
  subject: 'Please review your capstone project details: Exact link check',
  text: 'Open the exact capability URL: https://showcase.test/preview/token-123?check=exact',
  html: '<p><a href="https://showcase.test/preview/token-123?check=exact">Open preview</a></p>',
  messageId: '<pp-87a8f7c9e0d1b2a387a8f7c9e0d1b2a3@capstone.test>',
};

const API_KEY = 'api-mock-test-key-12345';
const BASE_CONFIG = {
  apiKey: API_KEY,
  from: 'noreply@capstone.test',
  fromName: 'Capstone Impact',
};

function successfulResponse(
  data: Record<string, unknown> = {
    succeeded: 1,
    failed: 0,
    failures: [],
    email_id: 'smtp2go-email-123',
  },
): Response {
  return new Response(JSON.stringify({ request_id: 'request-123', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Smtp2goParticipantPreviewEmailTransport', () => {
  describe('security and endpoint validation', () => {
    it('rejects cleartext non-loopback and non-HTTP endpoints', () => {
      for (const endpoint of [
        'http://api.smtp2go.com/v3/email/send',
        'ftp://localhost/email',
        'file://localhost/email',
        'ws://localhost/email',
      ]) {
        expect(() => new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, { endpoint })).toThrow(
          /HTTPS or HTTP\/HTTPS loopback/,
        );
      }
    });

    it('accepts HTTPS and loopback HTTP endpoints for local tests', () => {
      expect(() => new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG)).not.toThrow();
      expect(() =>
        new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
          endpoint: 'https://provider.example.test/v3/email/send',
        }),
      ).not.toThrow();
      expect(() =>
        new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
          endpoint: 'http://localhost:8080/v3/email/send',
        }),
      ).not.toThrow();
      expect(() =>
        new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
          endpoint: 'http://127.0.0.1:8080/v3/email/send',
        }),
      ).not.toThrow();
      expect(() =>
        new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
          endpoint: 'http://[::1]:8080/v3/email/send',
        }),
      ).not.toThrow();
    });

    it('rejects malformed or credential-bearing endpoint URLs', () => {
      for (const endpoint of ['not a URL', 'https://user:password@provider.example.test/send']) {
        expect(() => new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, { endpoint })).toThrow(
          /HTTPS or HTTP\/HTTPS loopback/,
        );
      }
    });
  });

  describe('documented send contract', () => {
    it('sends one exact standard-email payload and accepts the documented 200 response', async () => {
      let capturedUrl = '';
      let capturedOptions: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
        capturedUrl = url;
        capturedOptions = options;
        return successfulResponse();
      });

      const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);

      expect(result).toEqual({ outcome: 'accepted', transportReference: 'smtp2go-email-123' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(SMTP2GO_TRANSACTIONAL_EMAIL_ENDPOINT);
      expect(capturedOptions?.method).toBe('POST');
      expect(capturedOptions?.redirect).toBe('error');
      expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);

      const headers = capturedOptions?.headers as Record<string, string>;
      expect(headers.Accept).toBe('application/json');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Smtp2go-Api-Key']).toBe(API_KEY);

      const body = JSON.parse(capturedOptions?.body as string);
      expect(body).not.toHaveProperty('api_key');
      expect(body.sender).toBe('"Capstone Impact" <noreply@capstone.test>');
      expect(body.to).toEqual([SAMPLE_MESSAGE.recipient]);
      expect(body.subject).toBe(SAMPLE_MESSAGE.subject);
      expect(body.html_body).toBe(SAMPLE_MESSAGE.html);
      expect(body.text_body).toBe(SAMPLE_MESSAGE.text);
      expect(body.custom_headers).toEqual([
        { header: 'Message-ID', value: SAMPLE_MESSAGE.messageId },
      ]);
      expect(body.fastaccept).toBe(true);
    });

    it('preserves capability-bearing HTML and plaintext byte-for-byte in the request', async () => {
      const mockFetch = vi.fn().mockResolvedValue(successfulResponse());
      const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await transport.send(SAMPLE_MESSAGE);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.html_body).toBe(SAMPLE_MESSAGE.html);
      expect(body.text_body).toBe(SAMPLE_MESSAGE.text);
      expect(body.html_body).not.toContain('track.smtp2go.com');
      expect(body.html_body).not.toContain('utm_');
    });

    it('never turns an unverifiable local sandbox flag into a no-delivery claim', async () => {
      const mockFetch = vi.fn().mockResolvedValue(successfulResponse());
      const staleLocalConfig = { ...BASE_CONFIG, sandbox: true };
      const transport = new Smtp2goParticipantPreviewEmailTransport(
        staleLocalConfig,
        { fetchFn: mockFetch as unknown as typeof fetch },
      );

      expect(await transport.send(SAMPLE_MESSAGE)).toEqual({
        outcome: 'accepted',
        transportReference: 'smtp2go-email-123',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body).not.toHaveProperty('sandbox');
    });

    it('quotes and escapes the sender display name without changing the sender address', async () => {
      const mockFetch = vi.fn().mockResolvedValue(successfulResponse());
      const transport = new Smtp2goParticipantPreviewEmailTransport(
        { ...BASE_CONFIG, fromName: 'Capstone "Impact" \\ Operations <Team>' },
        { fetchFn: mockFetch as unknown as typeof fetch },
      );

      await transport.send(SAMPLE_MESSAGE);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.sender).toBe('"Capstone \\"Impact\\" \\\\ Operations <Team>" <noreply@capstone.test>');
    });

    it('refuses an invalid custom Message-ID before making a provider request', async () => {
      for (const messageId of [
        '<pp-short@capstone.test>',
        '<pp-87a8f7c9e0d1b2a387a8f7c9e0d1b2a3@capstone.test>\r\nBcc: attacker@example.test',
      ]) {
        const mockFetch = vi.fn();
        const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
          fetchFn: mockFetch as unknown as typeof fetch,
        });

        await expect(transport.send({ ...SAMPLE_MESSAGE, messageId })).resolves.toEqual({
          outcome: 'rejected',
          failureCode: 'MESSAGE_REJECTED',
        });
        expect(mockFetch).not.toHaveBeenCalled();
      }
    });

    it('requires the documented success fields before claiming acceptance', async () => {
      const invalidSuccessBodies = [
        { succeeded: 0, failed: 0, failures: [], email_id: 'id' },
        { succeeded: 1, failed: 1, failures: [], email_id: 'id' },
        { succeeded: 1, failed: 0, failures: [{ error: 'refused' }], email_id: 'id' },
        { succeeded: 1, failed: 0, failures: [], email_id: '' },
        { succeeded: 1, failed: 0, failures: [], email_id: 'x'.repeat(201) },
        { succeeded: '1', failed: 0, failures: [], email_id: 'id' },
      ];

      for (const data of invalidSuccessBodies) {
        const mockFetch = vi.fn().mockResolvedValue(successfulResponse(data));
        const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
          fetchFn: mockFetch as unknown as typeof fetch,
        });

        const result = await transport.send(SAMPLE_MESSAGE);
        expect(result).toEqual(
          data.failed === 1 || data.failures.length > 0
            ? { outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' }
            : { outcome: 'unknown' },
        );
      }
    });

    it('treats a provider-reported 200 failure as a reliable message refusal', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        successfulResponse({
          succeeded: 0,
          failed: 1,
          failures: [{ error: 'recipient refused' }],
        }),
      );
      const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(await transport.send(SAMPLE_MESSAGE)).toEqual({
        outcome: 'rejected',
        failureCode: 'MESSAGE_REJECTED',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('bounded and asymmetric outcomes', () => {
    it('treats malformed, empty, missing, and oversized success responses as unknown', async () => {
      const responses = [
        new Response('', { status: 200 }),
        new Response('   ', { status: 200 }),
        new Response('{not-json', { status: 200 }),
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
        new Response(JSON.stringify({ request_id: 'id' }), { status: 200 }),
        new Response(
          JSON.stringify({
            data: { succeeded: 1, failed: 0, failures: [], email_id: 'id' },
          }),
          { status: 200 },
        ),
        new Response(
          JSON.stringify({
            request_id: 'id',
            data: { succeeded: 1, failed: 0, failures: [], email_id: 'id', padding: 'x'.repeat(70_000) },
          }),
          { status: 200 },
        ),
      ];

      for (const response of responses) {
        const mockFetch = vi.fn().mockResolvedValue(response);
        const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
          fetchFn: mockFetch as unknown as typeof fetch,
        });

        expect(await transport.send(SAMPLE_MESSAGE)).toEqual({ outcome: 'unknown' });
      }
    });

    it('accepts only the documented 200 status for a standard-email success', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: { succeeded: 1, failed: 0, failures: [], email_id: 'id-201' },
          }),
          { status: 201 },
        ),
      );
      const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(await transport.send(SAMPLE_MESSAGE)).toEqual({ outcome: 'unknown' });
    });

    it.each([
      [400, 'MESSAGE_REJECTED'],
      [402, 'MESSAGE_REJECTED'],
      [429, 'MESSAGE_REJECTED'],
      [401, 'TRANSPORT_UNAVAILABLE'],
      [403, 'TRANSPORT_UNAVAILABLE'],
      [404, 'TRANSPORT_UNAVAILABLE'],
    ] as const)('classifies documented HTTP %s as %s', async (status, failureCode) => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('provider error with secret details', { status }));
      const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(await transport.send(SAMPLE_MESSAGE)).toEqual({ outcome: 'rejected', failureCode });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each([500, 502, 503, 504])('treats documented HTTP %s as unknown', async (status) => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('provider error', { status }));
      const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(await transport.send(SAMPLE_MESSAGE)).toEqual({ outcome: 'unknown' });
    });

    it('treats redirect, network, and timeout failures as unknown without retrying', async () => {
      for (const error of [
        new Error('redirect to a credential-bearing URL'),
        new Error('socket closed after dispatch'),
        Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
      ]) {
        const mockFetch = vi.fn().mockRejectedValue(error);
        const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
          fetchFn: mockFetch as unknown as typeof fetch,
        });

        expect(await transport.send(SAMPLE_MESSAGE)).toEqual({ outcome: 'unknown' });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }
    });

    it('never surfaces the API key, recipient, body, capability URL, or provider error text in its result', async () => {
      const providerError = `${API_KEY} ${SAMPLE_MESSAGE.recipient} ${SAMPLE_MESSAGE.text} provider-secret-error`;
      const mockFetch = vi.fn().mockResolvedValue(new Response(providerError, { status: 400 }));
      const transport = new Smtp2goParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const serialized = JSON.stringify(await transport.send(SAMPLE_MESSAGE));
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toContain(SAMPLE_MESSAGE.recipient);
      expect(serialized).not.toContain(SAMPLE_MESSAGE.text);
      expect(serialized).not.toContain('provider-secret-error');
      expect(serialized).toContain('MESSAGE_REJECTED');

      const requestBody = JSON.stringify(mockFetch.mock.calls[0][1].body);
      expect(requestBody).not.toContain(API_KEY);
    });
  });
});
