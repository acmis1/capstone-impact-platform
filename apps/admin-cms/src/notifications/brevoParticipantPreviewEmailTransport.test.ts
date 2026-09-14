import { describe, it, expect, vi } from 'vitest';
import {
  BrevoParticipantPreviewEmailTransport,
  deriveDeterministicIdempotencyKey,
  BREVO_TRANSACTIONAL_EMAIL_ENDPOINT,
} from './brevoParticipantPreviewEmailTransport';
import type { ParticipantPreviewEmailMessage } from './participantPreviewEmailTransport';

const SAMPLE_MESSAGE: ParticipantPreviewEmailMessage = {
  recipient: 'participant@example.test',
  subject: 'Please review your capstone project details: AI Impact Showcase',
  text: 'Hello, please review your project details at https://showcase.test/prev/token123',
  html: '<p>Hello, please review your project details at <a href="https://showcase.test/prev/token123">link</a></p>',
  messageId: '<pp-87a8f7c9e0d1b2a3@capstone.test>',
};

const BASE_CONFIG = {
  apiKey: 'xkeysib-test-api-key-999',
  from: 'noreply@capstone.test',
  fromName: 'Capstone Platform',
  sandbox: false,
};

describe('BrevoParticipantPreviewEmailTransport', () => {
  describe('deriveDeterministicIdempotencyKey', () => {
    it('generates a valid UUID format deterministically from a Message-ID', () => {
      const key1 = deriveDeterministicIdempotencyKey(SAMPLE_MESSAGE.messageId);
      const key2 = deriveDeterministicIdempotencyKey(SAMPLE_MESSAGE.messageId);
      expect(key1).toBe(key2);
      // Verify UUID format (8-4-4-4-12 hex digits)
      expect(key1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('produces distinct keys for distinct Message-IDs', () => {
      const key1 = deriveDeterministicIdempotencyKey('<pp-1@capstone.test>');
      const key2 = deriveDeterministicIdempotencyKey('<pp-2@capstone.test>');
      expect(key1).not.toBe(key2);
    });
  });

  describe('security and endpoint validation', () => {
    it('rejects unencrypted cleartext HTTP endpoints for non-localhost addresses', () => {
      expect(() => {
        new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
          endpoint: 'http://api.brevo.com/v3/smtp/email',
        });
      }).toThrow(/HTTPS or HTTP\/HTTPS loopback/);
    });

    it('accepts localhost HTTP endpoints for local testing', () => {
      expect(() => {
        new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
          endpoint: 'http://localhost:8080/v3/smtp/email',
        });
      }).not.toThrow();

      expect(() => {
        new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
          endpoint: 'http://127.0.0.1:8080/v3/smtp/email',
        });
      }).not.toThrow();
    });

    it('rejects non-HTTP/HTTPS schemes even when hostname is localhost', () => {
      for (const badEndpoint of [
        'ftp://localhost:21/email',
        'file://localhost/path/to/email',
        'ws://localhost:8080/email',
      ]) {
        expect(() => {
          new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
            endpoint: badEndpoint,
          });
        }).toThrow(/HTTPS or HTTP\/HTTPS loopback/);
      }
    });
  });

  describe('send behavior and payload validation', () => {
    it('dispatches the correctly formatted payload and headers on success (201)', async () => {
      let capturedUrl = '';
      let capturedOptions: RequestInit | undefined;

      const mockFetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
        capturedUrl = url;
        capturedOptions = options;
        return new Response(JSON.stringify({ messageId: '<20260914.brevo-msg-123@smtp-relay.brevo.com>' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);

      expect(result).toEqual({
        outcome: 'accepted',
        transportReference: '<20260914.brevo-msg-123@smtp-relay.brevo.com>',
      });

      expect(capturedUrl).toBe(BREVO_TRANSACTIONAL_EMAIL_ENDPOINT);
      expect(capturedOptions?.method).toBe('POST');
      expect(capturedOptions?.redirect).toBe('error');

      const headers = capturedOptions?.headers as Record<string, string>;
      expect(headers['api-key']).toBe(BASE_CONFIG.apiKey);
      expect(headers['content-type']).toBe('application/json');
      expect(headers['accept']).toBe('application/json');
      // Transport headers must NOT leak special Brevo payload headers
      expect(headers['Idempotency-Key']).toBeUndefined();
      expect(headers['X-Sib-Sandbox']).toBeUndefined();

      const body = JSON.parse(capturedOptions?.body as string);
      expect(body.sender).toEqual({ email: 'noreply@capstone.test', name: 'Capstone Platform' });
      expect(body.to).toEqual([
        {
          email: 'participant@example.test',
          contactPixelTrackingConsent: false,
        },
      ]);
      expect(body.subject).toBe(SAMPLE_MESSAGE.subject);
      expect(body.htmlContent).toBe(SAMPLE_MESSAGE.html);
      expect(body.textContent).toBe(SAMPLE_MESSAGE.text);
      expect(body.tags).toEqual(['participant-preview']);
      // Non-standard headers belong in body.headers per Brevo v3 API documentation
      expect(body.headers).toBeDefined();
      expect(body.headers['Idempotency-Key']).toBe(deriveDeterministicIdempotencyKey(SAMPLE_MESSAGE.messageId));
      // Standard email headers must NOT be sent to Brevo
      expect(body.headers['Message-ID']).toBeUndefined();
      // Live sends must omit X-Sib-Sandbox
      expect(body.headers['X-Sib-Sandbox']).toBeUndefined();
    });

    it('labels sandbox mode acceptances with SANDBOX_NO_DELIVERY to prevent false delivery claims', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messageId: '<sandbox-msg-id-456>' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const transport = new BrevoParticipantPreviewEmailTransport(
        { ...BASE_CONFIG, sandbox: true },
        { fetchFn: mockFetch as unknown as typeof fetch },
      );

      const result = await transport.send(SAMPLE_MESSAGE);

      expect(result).toEqual({
        outcome: 'accepted',
        transportReference: 'SANDBOX_NO_DELIVERY:<sandbox-msg-id-456>',
      });

      const callArgs = mockFetch.mock.calls[0];
      const headers = callArgs[1].headers as Record<string, string>;
      // HTTP headers must NOT contain X-Sib-Sandbox or Idempotency-Key
      expect(headers['X-Sib-Sandbox']).toBeUndefined();
      expect(headers['Idempotency-Key']).toBeUndefined();

      // Per Brevo sandbox guide, X-Sib-Sandbox: drop belongs in JSON body headers
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.headers).toBeDefined();
      expect(body.headers['X-Sib-Sandbox']).toBe('drop');
      expect(body.headers['Idempotency-Key']).toBe(deriveDeterministicIdempotencyKey(SAMPLE_MESSAGE.messageId));
      expect(body.headers['Message-ID']).toBeUndefined();
    });

    it('treats empty, malformed, or missing messageId 201 responses as unknown', async () => {
      const testCases = [
        new Response('', { status: 201 }),
        new Response('   ', { status: 201 }),
        new Response('<html>Not JSON</html>', { status: 201 }),
        new Response(JSON.stringify({}), { status: 201 }),
        new Response(JSON.stringify({ messageId: '' }), { status: 201 }),
        new Response(JSON.stringify({ messageId: '   ' }), { status: 201 }),
        new Response(JSON.stringify({ messageId: 12345 }), { status: 201 }),
      ];

      for (const response of testCases) {
        const mockFetch = vi.fn().mockResolvedValue(response);
        const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
          fetchFn: mockFetch as unknown as typeof fetch,
        });

        const result = await transport.send(SAMPLE_MESSAGE);
        expect(result).toEqual({ outcome: 'unknown' });
      }
    });

    it('treats unsupported HTTP 200 responses as unknown', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messageId: '<msg-200>' }), { status: 200 }),
      );

      const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);
      expect(result).toEqual({ outcome: 'unknown' });
    });

    it('treats fetch redirect failure as unknown', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Redirect not allowed'));

      const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);
      expect(result).toEqual({ outcome: 'unknown' });
    });

    it('treats bounded oversized 201 response (>64 KiB) as unknown', async () => {
      const hugeData = { messageId: '<msg-huge>', padding: 'a'.repeat(70_000) };
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(hugeData), { status: 201 }),
      );

      const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);
      expect(result).toEqual({ outcome: 'unknown' });
    });

    it('classifies 401, 403, and 404 as TRANSPORT_UNAVAILABLE', async () => {
      for (const status of [401, 403, 404]) {
        const mockFetch = vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ code: 'unauthorized', message: 'Auth failed' }), {
            status,
          }),
        );

        const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
          fetchFn: mockFetch as unknown as typeof fetch,
        });

        const result = await transport.send(SAMPLE_MESSAGE);
        expect(result).toEqual({ outcome: 'rejected', failureCode: 'TRANSPORT_UNAVAILABLE' });
      }
    });

    it('classifies 429 quota/rate limit as MESSAGE_REJECTED without retrying', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Rate limit exceeded' }), {
          status: 429,
        }),
      );

      const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);
      expect(result).toEqual({ outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' });
      expect(mockFetch).toHaveBeenCalledTimes(1); // No blind tight retry loops
    });

    it('classifies 400 Bad Request with structured invalid recipient error as RECIPIENT_REJECTED', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'invalid_parameter', message: 'Invalid recipient email format' }),
          { status: 400 },
        ),
      );

      const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);
      expect(result).toEqual({ outcome: 'rejected', failureCode: 'RECIPIENT_REJECTED' });
    });

    it('classifies general 400 Bad Request refusal as MESSAGE_REJECTED without falsely inferring recipient rejection', async () => {
      // Even if the error message contains the word "email" in general context (e.g. sender email or template),
      // avoid broad heuristics and keep MESSAGE_REJECTED unless structured code matches
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'invalid_sender', message: 'Sender email domain not verified' }),
          { status: 400 },
        ),
      );

      const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);
      expect(result).toEqual({ outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' });
    });

    it('classifies 5xx server errors as unknown to prevent unsafe automatic retry', async () => {
      for (const status of [500, 502, 503, 504]) {
        const mockFetch = vi.fn().mockResolvedValue(
          new Response('Internal Server Error', { status }),
        );

        const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
          fetchFn: mockFetch as unknown as typeof fetch,
        });

        const result = await transport.send(SAMPLE_MESSAGE);
        expect(result).toEqual({ outcome: 'unknown' });
      }
    });

    it('classifies network aborts, dropped connections, and timeouts as unknown', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network connection terminated unexpectedly'));

      const transport = new BrevoParticipantPreviewEmailTransport(BASE_CONFIG, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const result = await transport.send(SAMPLE_MESSAGE);
      expect(result).toEqual({ outcome: 'unknown' });
    });
  });
});
