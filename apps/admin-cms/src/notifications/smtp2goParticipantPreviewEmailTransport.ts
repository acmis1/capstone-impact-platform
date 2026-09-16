import type { ParticipantPreviewEmailSmtp2goConfig } from './participantPreviewEmailConfig';
import type {
  ParticipantPreviewEmailMessage,
  ParticipantPreviewEmailTransport,
  ParticipantPreviewEmailTransportResult,
} from './participantPreviewEmailTransport';

/** SMTP2GO's documented Standard Email endpoint. */
export const SMTP2GO_TRANSACTIONAL_EMAIL_ENDPOINT = 'https://api.smtp2go.com/v3/email/send';

const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PARTICIPANT_PREVIEW_MESSAGE_ID = /^<pp-[a-f0-9]{32}@[a-z0-9.-]{1,253}>$/;

export interface Smtp2goTransportOptions {
  /** Test-only endpoint override; must be HTTPS or HTTP/HTTPS loopback. */
  endpoint?: string;
  /** Injected fetch implementation for deterministic unit testing. */
  fetchFn?: typeof fetch;
  /** Bounded timeout in milliseconds. Defaults to 10,000 ms. */
  timeoutMs?: number;
}

/** Only a short, printable-ASCII reference is ever surfaced; anything else is dropped. */
function boundedReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200 || !/^[!-~]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads a bounded response body as text without risking unbounded memory allocation.
 * Provider response text is never returned or logged.
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
              // Ignore stream cancellation errors.
            }
            return { ok: false, reason: 'TOO_LARGE' };
          }
          chunks.push(value);
        }
      }

      return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
    }

    // Fallback for mocked or synthetic response objects where body is not a ReadableStream.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, reason: 'TOO_LARGE' };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'READ_ERROR' };
  }
}

function assertAllowedEndpoint(rawEndpoint: string): string {
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new Error('SMTP2GO transport endpoint must use HTTPS or HTTP/HTTPS loopback for local tests.');
  }

  const hostname = url.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  const isAllowed =
    url.username === '' &&
    url.password === '' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback));

  if (!isAllowed) {
    throw new Error('SMTP2GO transport endpoint must use HTTPS or HTTP/HTTPS loopback for local tests.');
  }
  return rawEndpoint;
}

function formatSender(config: ParticipantPreviewEmailSmtp2goConfig): string {
  if (!config.fromName) return config.from;
  const displayName = config.fromName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${displayName}" <${config.from}>`;
}

function classifyHttpStatus(status: number): ParticipantPreviewEmailTransportResult {
  // These are the documented SMTP2GO request/authentication/refusal classes. A 5xx or any
  // undocumented status remains ambiguous because the provider may have accepted the message.
  if (status === 401 || status === 403 || status === 404) {
    return { outcome: 'rejected', failureCode: 'TRANSPORT_UNAVAILABLE' };
  }
  if (status === 400 || status === 402 || status === 429) {
    return { outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' };
  }
  return { outcome: 'unknown' };
}

function classifySuccessfulResponse(data: unknown): ParticipantPreviewEmailTransportResult {
  if (!isRecord(data)) return { outcome: 'unknown' };

  const failed = data.failed;
  const failures = data.failures;
  if ((typeof failed === 'number' && failed > 0) || (Array.isArray(failures) && failures.length > 0)) {
    return { outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' };
  }

  // SMTP2GO documents 200 with data.succeeded=1, failed=0, failures=[], and email_id as the
  // accepted standard-email contract. Every field is required before acceptance is asserted.
  if (
    data.succeeded !== 1 ||
    data.failed !== 0 ||
    !Array.isArray(failures) ||
    failures.length !== 0
  ) {
    return { outcome: 'unknown' };
  }

  const reference = boundedReference(data.email_id);
  if (!reference) return { outcome: 'unknown' };

  return { outcome: 'accepted', transportReference: reference };
}

/**
 * SMTP2GO Standard Email transport over HTTPS.
 *
 * The API has no documented idempotency-key facility. The existing opaque deterministic
 * Message-ID is therefore carried as an official custom email header; PostgreSQL's notification
 * lease remains the application-level at-most-once fence. No automatic retry occurs here.
 */
export class Smtp2goParticipantPreviewEmailTransport implements ParticipantPreviewEmailTransport {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ParticipantPreviewEmailSmtp2goConfig,
    options: Smtp2goTransportOptions = {},
  ) {
    this.endpoint = assertAllowedEndpoint(options.endpoint ?? SMTP2GO_TRANSACTIONAL_EMAIL_ENDPOINT);
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(
    message: ParticipantPreviewEmailMessage,
  ): Promise<ParticipantPreviewEmailTransportResult> {
    // The Message-ID becomes a provider custom header. Accept only the exact server-generated
    // participant-preview shape so an accidentally widened caller cannot inject another header.
    if (!PARTICIPANT_PREVIEW_MESSAGE_ID.test(message.messageId)) {
      return { outcome: 'rejected', failureCode: 'MESSAGE_REJECTED' };
    }

    const payload = {
      sender: formatSender(this.config),
      to: [message.recipient],
      subject: message.subject,
      html_body: message.html,
      text_body: message.text,
      custom_headers: [{ header: 'Message-ID', value: message.messageId }],
      fastaccept: true,
    };

    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Smtp2go-Api-Key': this.config.apiKey,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // A network failure, timeout or redirect may occur after the provider received the request.
      // It is therefore ambiguous and must never trigger a blind resend.
      return { outcome: 'unknown' };
    }

    if (response.status !== 200) {
      return classifyHttpStatus(response.status);
    }

    const readResult = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES);
    if (!readResult.ok || !readResult.text.trim()) {
      return { outcome: 'unknown' };
    }

    let body: unknown;
    try {
      body = JSON.parse(readResult.text);
    } catch {
      return { outcome: 'unknown' };
    }

    if (!isRecord(body) || !boundedReference(body.request_id) || !isRecord(body.data)) {
      return { outcome: 'unknown' };
    }

    return classifySuccessfulResponse(body.data);
  }
}
