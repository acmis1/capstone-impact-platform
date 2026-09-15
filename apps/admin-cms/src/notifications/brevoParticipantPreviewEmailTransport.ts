import crypto from 'node:crypto';
import type { ParticipantPreviewEmailBrevoConfig } from './participantPreviewEmailConfig';
import type {
  ParticipantPreviewEmailFailureCode,
  ParticipantPreviewEmailMessage,
  ParticipantPreviewEmailTransport,
  ParticipantPreviewEmailTransportResult,
} from './participantPreviewEmailTransport';

/**
 * Brevo transactional email transport over HTTPS.
 *
 * Implements the single temporary free HTTPS transport for participant preview notifications,
 * connecting to Brevo's REST API (`POST https://api.brevo.com/v3/smtp/email`).
 *
 * Designed to meet the following constraints:
 *   - Operates over standard HTTPS (port 443), succeeding on hosts where outbound SMTP
 *     ports (25/465/587) are blocked (such as Render Free).
 *   - Strictly preserves the asymmetric outcome contract (accepted / rejected / unknown).
 *   - Requests open-pixel anonymization via per-recipient `contactPixelTrackingConsent: false`.
 *   - Uses a deterministic UUID idempotency key derived from the message identity without
 *     bypassing the application-level durable ledger claim protections.
 *   - Sandbox mode responses are explicitly branded with `SANDBOX_NO_DELIVERY` so synthetic
 *     validation cannot be mistaken for real inbox delivery.
 *   - Definite 429 quota exhaustion or rate limits are treated as reliable refusals without
 *     blind retry loops.
 *   - Network timeouts, 5xx gateway errors, or transmission interruptions resolve to `unknown`
 *     so the delivery ledger never falsely claims non-delivery or triggers duplicate sends.
 *   - No credentials, authorization tokens, or capability URLs are ever logged or leaked.
 */

export const BREVO_TRANSACTIONAL_EMAIL_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export interface BrevoTransportOptions {
  /** Test-only endpoint override; must be HTTPS or localhost. */
  endpoint?: string;
  /** Injected fetch implementation for deterministic unit testing. */
  fetchFn?: typeof fetch;
  /** Bounded timeout in milliseconds. Defaults to 10,000 ms. */
  timeoutMs?: number;
}

/**
 * Derives a deterministic UUIDv4-format idempotency key from a Message-ID.
 *
 * Brevo's API requires `idempotencyKey` to follow standard UUID formatting.
 * Deriving it deterministically from the canonical Message-ID ensures that the same
 * notification execution produces the same key, without generating random state or
 * allowing retry callers to mint fresh keys.
 */
export function deriveDeterministicIdempotencyKey(messageId: string): string {
  const hash = crypto.createHash('sha256').update(messageId, 'utf8').digest('hex');
  const p1 = hash.slice(0, 8);
  const p2 = hash.slice(8, 12);
  const p3 = `4${hash.slice(13, 16)}`;
  const p4 = `8${hash.slice(17, 20)}`;
  const p5 = hash.slice(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/** Only a short, printable-ASCII reference is ever surfaced; anything else is dropped. */
function boundedReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200 || !/^[!-~]+$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Reads a bounded response body as text without risking unbounded memory allocation.
 * Returns an error if the body exceeds maxBytes or if the stream read fails.
 */
async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: 'TOO_LARGE' | 'READ_ERROR' }> {
  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytesRead = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesRead += value.byteLength;
          if (bytesRead > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // Ignore stream cancellation error
            }
            return { ok: false, reason: 'TOO_LARGE' };
          }
          chunks.push(value);
        }
      }

      return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
    }

    // Fallback for mocked or synthetic response objects where body is not a ReadableStream
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, reason: 'TOO_LARGE' };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'READ_ERROR' };
  }
}

export class BrevoParticipantPreviewEmailTransport implements ParticipantPreviewEmailTransport {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ParticipantPreviewEmailBrevoConfig,
    options: BrevoTransportOptions = {},
  ) {
    const rawEndpoint = options.endpoint ?? BREVO_TRANSACTIONAL_EMAIL_ENDPOINT;
    // Security check: only allow https endpoints, or http/https loopback for local tests
    const url = new URL(rawEndpoint);
    const isLoopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1';

    const isAllowed =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopback);

    if (!isAllowed) {
      throw new Error('Brevo transport endpoint must use HTTPS or HTTP/HTTPS loopback for local tests.');
    }
    this.endpoint = rawEndpoint;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(
    message: ParticipantPreviewEmailMessage,
  ): Promise<ParticipantPreviewEmailTransportResult> {
    const idempotencyKey = deriveDeterministicIdempotencyKey(message.messageId);

    // Brevo request payload:
    // - Non-standard email headers (Idempotency-Key, and X-Sib-Sandbox in sandbox mode) belong in the body's `headers` map.
    // - Standard email headers (such as Message-ID) must NOT be included in Brevo's headers map.
    // - contactPixelTrackingConsent: false requests open-pixel anonymization when enabled on the Brevo account.
    const payload: Record<string, unknown> = {
      sender: {
        email: this.config.from,
        ...(this.config.fromName ? { name: this.config.fromName } : {}),
      },
      to: [
        {
          email: message.recipient,
          // Requests open-pixel anonymization when the account tracking feature is enabled
          contactPixelTrackingConsent: false,
        },
      ],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
      headers: {
        'Idempotency-Key': idempotencyKey,
        ...(this.config.sandbox ? { 'X-Sib-Sandbox': 'drop' } : {}),
      },
      tags: ['participant-preview'],
    };

    const httpHeaders: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': this.config.apiKey,
    };

    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: httpHeaders,
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network drops, socket timeouts, redirect errors, DNS aborts post-dispatch are inherently ambiguous:
      // the server may have received the payload and queued the mail. Calling this a failure
      // would invite an automatic resend and potentially duplicate email.
      return { outcome: 'unknown' };
    }

    // Documented Brevo success for single-send is strictly HTTP 201 Created carrying a provider messageId.
    // HTTP 200 is not accepted as standard single-send success; falls through to classifyErrorResponse -> unknown.
    if (response.status === 201) {
      const readResult = await readBoundedResponseBody(response, 65_536);
      if (!readResult.ok || !readResult.text.trim()) {
        return { outcome: 'unknown' };
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(readResult.text) as Record<string, unknown>;
      } catch {
        return { outcome: 'unknown' };
      }

      const rawMsgId = typeof body?.messageId === 'string' ? body.messageId.trim() : '';
      const ref = boundedReference(rawMsgId);
      if (!ref) {
        // Missing or invalid provider messageId
        return { outcome: 'unknown' };
      }

      const transportReference = this.config.sandbox
        ? `SANDBOX_NO_DELIVERY:${ref}`
        : ref;

      return {
        outcome: 'accepted',
        transportReference,
      };
    }

    // Classify HTTP error responses
    return this.classifyErrorResponse(response);
  }

  private async classifyErrorResponse(
    response: Response,
  ): Promise<ParticipantPreviewEmailTransportResult> {
    const status = response.status;

    // 401 Unauthorized / 403 Forbidden: authentication failure or IP restriction.
    // Definite transport configuration refusal where no message was accepted.
    if (status === 401 || status === 403) {
      return { outcome: 'rejected', failureCode: 'TRANSPORT_UNAVAILABLE' };
    }

    // 404 Not Found: misconfigured endpoint.
    if (status === 404) {
      return { outcome: 'rejected', failureCode: 'TRANSPORT_UNAVAILABLE' };
    }

    // 429 Too Many Requests: rate limit or immediate quota refusal.
    // Definite refusal of this attempt.
    if (status === 429) {
      return { outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' };
    }

    // 400 Bad Request: client error or payload refusal.
    // Preserves reliable rejected outcome without requiring unbounded body consumption.
    if (status === 400) {
      let failureCode: ParticipantPreviewEmailFailureCode = 'MESSAGE_REJECTED';
      const readResult = await readBoundedResponseBody(response, 8_192);
      if (readResult.ok && readResult.text.trim()) {
        try {
          const data = JSON.parse(readResult.text) as { code?: unknown; message?: unknown };
          const code = typeof data.code === 'string' ? data.code.toLowerCase() : '';
          const msg = typeof data.message === 'string' ? data.message.toLowerCase() : '';

          if (code === 'unauthorized' || code === 'permission_denied' || code === 'bad_request_api_key') {
            failureCode = 'TRANSPORT_UNAVAILABLE';
          } else if (
            code === 'invalid_parameter' &&
            (msg.includes('recipient') || msg.includes('to.email') || msg.includes('invalid recipient'))
          ) {
            failureCode = 'RECIPIENT_REJECTED';
          }
        } catch {
          // Fall back to default MESSAGE_REJECTED on parse failure
        }
      }
      return { outcome: 'rejected', failureCode };
    }

    // 200 OK (unsupported for single-send), 5xx Server Errors (500, 502, 503, 504), or any unexpected status code:
    // We cannot verify whether the upstream server queued the message before failing,
    // so this must remain unknown rather than a false failure.
    return { outcome: 'unknown' };
  }
}
