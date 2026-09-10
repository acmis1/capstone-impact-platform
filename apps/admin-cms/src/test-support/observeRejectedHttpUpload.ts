import type { ClientRequest, IncomingMessage } from 'node:http';

export type RejectedUploadOutcome =
  | { kind: 'response'; response: { statusCode: number; body: Buffer } }
  | { kind: 'early-close'; errorCode: 'EPIPE' | 'ECONNRESET' };

/**
 * Test-only observer for a server rejecting a request before the client finishes writing.
 * Node can emit res.aborted, req.close, res.error(ECONNRESET), res.close in that order.
 * Wait for both close events; never let a socket error hide an observed bad status/body.
 * See Node 24 HTTP documentation, ClientRequest event ordering.
 */
export function observeRejectedHttpUpload(
  request: ClientRequest,
  timeoutMs = 2_000,
): Promise<RejectedUploadOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let requestClosed = false;
    let response: IncomingMessage | null = null;
    let responseClosed = false;
    let responseEnded = false;
    let responseBytes = 0;
    let allowedError: 'EPIPE' | 'ECONNRESET' | null = null;
    let unexpectedError: Error | null = null;
    const finish = (error: Error | null, result?: RejectedUploadOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const inspect = () => {
      if (settled || !requestClosed || (response && !responseClosed)) return;
      if (unexpectedError) { finish(unexpectedError); return; }
      if (response && (response.statusCode !== 413 || responseBytes !== 0)) {
        finish(new Error('SYNTHETIC_OVERSIZED_RESPONSE_INVALID'));
      } else if (response && responseEnded) {
        finish(null, { kind: 'response', response: { statusCode: 413, body: Buffer.alloc(0) } });
      } else if (allowedError) {
        finish(null, { kind: 'early-close', errorCode: allowedError });
      } else {
        finish(new Error('SYNTHETIC_OVERSIZED_UNEXPLAINED_CLOSE'));
      }
    };
    const recordError = (error: Error & { code?: string }) => {
      if (settled) return;
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') allowedError = error.code;
      else unexpectedError = error;
      inspect();
    };
    const timer = setTimeout(() => {
      finish(new Error('SYNTHETIC_OVERSIZED_REQUEST_TIMED_OUT'));
      request.destroy();
    }, timeoutMs);
    // Retain error listeners through teardown so late duplicate events do not become uncaught.
    request.on('error', recordError);
    request.once('close', () => { requestClosed = true; inspect(); });
    request.once('response', (incoming: IncomingMessage) => {
      response = incoming;
      incoming.on('data', (chunk: Buffer | string) => {
        responseBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      });
      incoming.on('error', recordError);
      // An aborted response can report its ECONNRESET only after request.close.
      incoming.once('aborted', () => { responseEnded = false; });
      incoming.once('end', () => { responseEnded = true; });
      incoming.once('close', () => { responseClosed = true; inspect(); });
    });
  });
}
