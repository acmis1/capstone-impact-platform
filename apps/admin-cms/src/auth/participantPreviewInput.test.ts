import { describe, expect, it } from 'vitest';
import { validatePreviewPublicId } from './participantPreviewInput';

describe('project public ID validation', () => {
  it.each(['abc-123', 'abc_123', 'a'.repeat(100)])('accepts %s', (value) => expect(validatePreviewPublicId(value)).toMatchObject({ valid: true }));
  it.each(['', ' ', 'a'.repeat(101), 'bad/id'])('rejects invalid value', (value) => expect(validatePreviewPublicId(value)).toMatchObject({ valid: false }));
});
