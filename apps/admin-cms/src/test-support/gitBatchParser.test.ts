import { describe, expect, it } from 'vitest';
import { parseGitBatchObjects, readGitMigrationObjects } from './gitBatchParser';

const oid = 'a'.repeat(40);
const object = (text: string) => {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from(`${oid} blob ${body.length}\n`), body, Buffer.from('\n')]);
};

describe('bounded binary Git batch parser', () => {
  it('returns ordered blobs using byte lengths, including UTF-8, embedded newlines and empty content', () => {
    const bodies = ['alpha\nbeta', 'Tiếng Việt — 日本語', '', '\0\n'];
    const result = parseGitBatchObjects(Buffer.concat(bodies.map(object)), bodies.length);
    expect(result.map(item => item.toString('utf8'))).toEqual(bodies);
  });
  it('accepts an empty batch without invoking Git', () => {
    expect(parseGitBatchObjects(Buffer.alloc(0), 0)).toEqual([]);
    expect(readGitMigrationObjects('does-not-exist', [])).toEqual([]);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid count %s', count => {
    expect(() => parseGitBatchObjects(Buffer.alloc(0), count)).toThrow('GIT_BATCH_INVALID_OBJECT_COUNT');
  });
  it.each(['', '\n', 'x\ny', 'x\ry', 'x\0y'])('refuses a malformed reference before process creation', ref => {
    expect(() => readGitMigrationObjects('does-not-exist', [ref])).toThrow('GIT_BATCH_INVALID_REFERENCE');
  });
  it.each([
    ['missing object', Buffer.from('missing-ref missing\n'), 'GIT_BATCH_OBJECT_MISSING'],
    ['non-blob', Buffer.from(`${oid} tree 0\n\n`), 'GIT_BATCH_MALFORMED_HEADER'],
    ['malformed header', Buffer.from('garbage\n'), 'GIT_BATCH_MALFORMED_HEADER'],
    ['missing header terminator', Buffer.from(`${oid} blob 0`), 'GIT_BATCH_MALFORMED_HEADER'],
    ['truncated body', Buffer.from(`${oid} blob 4\nab\n`), 'GIT_BATCH_MALFORMED_BODY'],
    ['missing body delimiter', Buffer.from(`${oid} blob 2\nab`), 'GIT_BATCH_MALFORMED_BODY'],
    ['wrong delimiter', Buffer.from(`${oid} blob 2\nabx`), 'GIT_BATCH_MALFORMED_BODY'],
    ['unsafe size', Buffer.from(`${oid} blob 9007199254740992\n`), 'GIT_BATCH_INVALID_OBJECT_SIZE'],
    ['negative size', Buffer.from(`${oid} blob -1\n`), 'GIT_BATCH_MALFORMED_HEADER'],
    ['extra output', Buffer.concat([object('a'), Buffer.from('x')]), 'GIT_BATCH_UNEXPECTED_OUTPUT'],
    ['extra object', Buffer.concat([object('a'), object('b')]), 'GIT_BATCH_UNEXPECTED_OUTPUT'],
  ])('rejects %s', (_name, bytes, message) => {
    expect(() => parseGitBatchObjects(bytes as Buffer, 1)).toThrow(message as string);
  });
  it('does not accept output for an expected zero-object batch', () => {
    expect(() => parseGitBatchObjects(object('unexpected'), 0)).toThrow('GIT_BATCH_UNEXPECTED_OUTPUT');
  });
  it('does not confuse character count with byte count', () => {
    expect(() => parseGitBatchObjects(Buffer.from(`${oid} blob 1\né\n`, 'utf8'), 1)).toThrow('GIT_BATCH_MALFORMED_BODY');
  });
  it('does not let non-ASCII header bytes alias valid ASCII hex', () => {
    const bytes = object('x'); bytes[0] = 0xe1;
    expect(() => parseGitBatchObjects(bytes, 1)).toThrow('GIT_BATCH_MALFORMED_HEADER');
  });
});
