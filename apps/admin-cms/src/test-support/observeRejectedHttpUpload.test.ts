import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeRejectedHttpUpload } from './observeRejectedHttpUpload';

function fixtures(statusCode = 413) {
  const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const response = Object.assign(new EventEmitter(), { statusCode });
  const observed = observeRejectedHttpUpload(request as unknown as ClientRequest);
  const respond = () => request.emit('response', response as unknown as IncomingMessage);
  return { request, response, observed, respond };
}
const error = (code: string) => Object.assign(new Error(code), { code });
afterEach(() => vi.useRealTimers());

describe('oversized HTTP request rejection event observer', () => {
  it.each(['request-first', 'response-first'])('accepts complete empty 413 with %s close order', async order => {
    const f = fixtures(); f.respond(); f.response.emit('end');
    if (order === 'request-first') { f.request.emit('close'); f.response.emit('close'); }
    else { f.response.emit('close'); f.request.emit('close'); }
    expect(await f.observed).toEqual({ kind: 'response', response: { statusCode: 413, body: Buffer.alloc(0) } });
  });
  it.each(['EPIPE', 'ECONNRESET'])('accepts an exact %s before any response', async code => {
    const f = fixtures(); f.request.emit('error', error(code)); f.request.emit('close');
    expect(await f.observed).toEqual({ kind: 'early-close', errorCode: code });
  });
  it('waits through the documented aborted -> request close -> response error -> response close order', async () => {
    const f = fixtures(); f.respond(); f.response.emit('aborted'); f.request.emit('close');
    const completion = vi.fn(); void f.observed.then(completion);
    await Promise.resolve(); expect(completion).not.toHaveBeenCalled();
    f.response.emit('error', error('ECONNRESET')); f.response.emit('close');
    expect(await f.observed).toEqual({ kind: 'early-close', errorCode: 'ECONNRESET' });
  });
  it.each([200, 400, 500, undefined])('does not let EPIPE mask an observed status %s', async status => {
    const f = fixtures(status); f.response.statusCode = status as number;
    f.respond(); f.request.emit('error', error('EPIPE')); f.request.emit('close'); f.response.emit('close');
    await expect(f.observed).rejects.toThrow('SYNTHETIC_OVERSIZED_RESPONSE_INVALID');
  });
  it('does not let ECONNRESET mask a nonempty 413 body', async () => {
    const f = fixtures(); f.respond(); f.response.emit('data', Buffer.from('unexpected'));
    f.response.emit('aborted'); f.request.emit('close'); f.response.emit('error', error('ECONNRESET')); f.response.emit('close');
    await expect(f.observed).rejects.toThrow('SYNTHETIC_OVERSIZED_RESPONSE_INVALID');
  });
  it.each(['ECONNREFUSED', 'ENOENT', 'ETIMEDOUT'])('rejects unexpected error %s', async code => {
    const f = fixtures(); f.request.emit('error', error(code)); f.request.emit('close');
    await expect(f.observed).rejects.toThrow(code);
  });
  it('does not let a second allowed error replace a previous unexpected error', async () => {
    const f = fixtures(); f.request.emit('error', error('ECONNREFUSED'));
    f.request.emit('error', error('EPIPE')); f.request.emit('close');
    await expect(f.observed).rejects.toThrow('ECONNREFUSED');
  });
  it.each([false, true])('rejects an unexplained close with response=%s', async hasResponse => {
    const f = fixtures();
    if (hasResponse) { f.respond(); f.response.emit('aborted'); f.response.emit('close'); }
    f.request.emit('close');
    await expect(f.observed).rejects.toThrow('SYNTHETIC_OVERSIZED_UNEXPLAINED_CLOSE');
  });
  it('destroys a stalled request at the existing bounded deadline', async () => {
    vi.useFakeTimers(); const f = fixtures();
    const rejection = expect(f.observed).rejects.toThrow('SYNTHETIC_OVERSIZED_REQUEST_TIMED_OUT');
    await vi.advanceTimersByTimeAsync(2_000); await rejection;
    expect(f.request.destroy).toHaveBeenCalledExactlyOnceWith();
  });
  it('handles duplicate late close/error events without throwing after settlement', async () => {
    const f = fixtures(); f.request.emit('error', error('EPIPE')); f.request.emit('close');
    await f.observed;
    expect(() => { f.request.emit('error', error('ECONNRESET')); f.request.emit('close'); }).not.toThrow();
  });
  it('retains the response error listener during late teardown', async () => {
    const f = fixtures(); f.respond(); f.response.emit('end'); f.response.emit('close'); f.request.emit('close');
    await f.observed;
    expect(() => f.response.emit('error', error('ECONNRESET'))).not.toThrow();
  });
});
