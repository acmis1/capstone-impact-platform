import { describe, it, expect } from 'vitest';
import {
  MAX_EMAIL_SUBJECT_LENGTH,
  ParticipantPreviewEmailRenderError,
  buildParticipantPreviewEmailSubject,
  buildParticipantPreviewMessageId,
  formatPreviewExpiry,
  renderParticipantPreviewEmailHtml,
  renderParticipantPreviewEmailText,
  sanitizeHeaderText,
} from './participantPreviewEmailMessage';
import {
  MAX_PARTICIPANT_CONTACT_EMAIL_LENGTH,
  containsControlCharacter,
  normalizeParticipantContactEmail,
  validateParticipantContactEmail,
} from '../domain/participantContactEmail';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

const CONTENT = {
  projectTitle: 'Smart Traffic Analysis',
  previewUrl: 'https://admin.example.test/participant-preview/' + 'a'.repeat(64),
  expiresAt: '2026-08-20T10:00:00.000Z',
};

describe('participant contact email contract', () => {
  it('normalizes to trimmed lowercase without altering the address itself', () => {
    expect(normalizeParticipantContactEmail('  Group.Alpha@Example.TEST  ')).toBe(
      'group.alpha@example.test',
    );
    const result = validateParticipantContactEmail('  Group.Alpha@Example.TEST  ');
    expect(result).toEqual({ valid: true, email: 'group.alpha@example.test' });
  });

  it('separates a missing contact from an invalid one', () => {
    expect(validateParticipantContactEmail('')).toEqual({ valid: false, reason: 'MISSING' });
    expect(validateParticipantContactEmail('   ')).toEqual({ valid: false, reason: 'MISSING' });
    expect(validateParticipantContactEmail(null)).toEqual({ valid: false, reason: 'MISSING' });
    expect(validateParticipantContactEmail(undefined)).toEqual({ valid: false, reason: 'MISSING' });
    expect(validateParticipantContactEmail('not-an-email')).toEqual({ valid: false, reason: 'INVALID' });
  });

  it('rejects every shape that could smuggle a second recipient or an extra header', () => {
    const attacks = [
      `group@example.test${CR}${LF}Bcc: attacker@evil.test`,
      `group@example.test${LF}Subject: hijacked`,
      `group@example.test${NUL}`,
      'group@example.test, attacker@evil.test',
      'group@example.test attacker@evil.test',
      'group@@example.test',
      'group@example',
      '@example.test',
      'group@.test',
    ];
    for (const attack of attacks) {
      expect(validateParticipantContactEmail(attack)).toEqual({ valid: false, reason: 'INVALID' });
    }
  });

  it('enforces the same length bound the database enforces', () => {
    const local = 'a'.repeat(MAX_PARTICIPANT_CONTACT_EMAIL_LENGTH);
    expect(validateParticipantContactEmail(`${local}@example.test`)).toEqual({
      valid: false,
      reason: 'INVALID',
    });
  });

  it('detects C0 and C1 control characters', () => {
    expect(containsControlCharacter('plain text')).toBe(false);
    expect(containsControlCharacter(`line${LF}break`)).toBe(true);
    expect(containsControlCharacter(`carriage${CR}return`)).toBe(true);
    expect(containsControlCharacter(String.fromCharCode(0x85))).toBe(true);
  });
});

describe('mail header safety', () => {
  it('collapses newlines and control characters out of header text', () => {
    expect(sanitizeHeaderText(`Title${CR}${LF}Bcc: attacker@evil.test`)).toBe(
      'Title Bcc: attacker@evil.test',
    );
    expect(sanitizeHeaderText(`a${NUL}b`)).toBe('a b');
    expect(containsControlCharacter(sanitizeHeaderText(`x${LF}y`))).toBe(false);
  });

  it('produces a bounded single-line subject even from a pathological title', () => {
    const subject = buildParticipantPreviewEmailSubject(`${'X'.repeat(500)}${LF}injected`);
    expect(subject.length).toBeLessThanOrEqual(MAX_EMAIL_SUBJECT_LENGTH);
    expect(containsControlCharacter(subject)).toBe(false);
  });

  it('still produces a usable subject when the project has no title', () => {
    expect(buildParticipantPreviewEmailSubject('')).toBe('Please review your capstone project details');
  });
});

describe('message rendering', () => {
  it('includes the exact secure preview URL and the expiry in both bodies', () => {
    const text = renderParticipantPreviewEmailText(CONTENT);
    const html = renderParticipantPreviewEmailHtml(CONTENT);
    const expiry = formatPreviewExpiry(CONTENT.expiresAt);

    expect(text).toContain(CONTENT.previewUrl);
    expect(html).toContain(CONTENT.previewUrl);
    expect(text).toContain(expiry);
    expect(html).toContain(expiry);
    expect(text).toContain('confirm');
    expect(html).toContain('confirm');
  });

  it('escapes untrusted imported project text instead of emitting live markup', () => {
    const html = renderParticipantPreviewEmailHtml({
      ...CONTENT,
      projectTitle: '<script>alert(1)</script> & "quoted" \'title\'',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
  });

  it('refuses to build an anchor for a non-http(s) preview URL', () => {
    expect(() =>
      renderParticipantPreviewEmailHtml({ ...CONTENT, previewUrl: 'javascript:alert(1)' }),
    ).toThrow(ParticipantPreviewEmailRenderError);
    expect(() =>
      renderParticipantPreviewEmailHtml({ ...CONTENT, previewUrl: 'data:text/html,<b>x</b>' }),
    ).toThrow(ParticipantPreviewEmailRenderError);
  });

  it('rejects an unparseable expiry rather than rendering a misleading date', () => {
    expect(() => renderParticipantPreviewEmailText({ ...CONTENT, expiresAt: 'not-a-date' })).toThrow(
      ParticipantPreviewEmailRenderError,
    );
  });

  it('never leaks internal identifiers or staff context into the participant message', () => {
    const text = renderParticipantPreviewEmailText(CONTENT);
    const html = renderParticipantPreviewEmailHtml(CONTENT);
    for (const body of [text, html]) {
      expect(body).not.toContain('/admin/');
      expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(body.toLowerCase()).not.toContain('service_role');
      expect(body.toLowerCase()).not.toContain('projects.review');
    }
  });
});

describe('message identity', () => {
  it('is deterministic for a lifecycle and opaque about the identifier behind it', () => {
    const notificationId = 'd2b1c0f4-1111-2222-3333-444455556666';
    const first = buildParticipantPreviewMessageId(notificationId, 'no-reply@example.test');
    const second = buildParticipantPreviewMessageId(notificationId, 'no-reply@example.test');

    expect(first).toBe(second);
    expect(first).toMatch(/^<pp-[0-9a-f]{32}@example\.test>$/);
    expect(first).not.toContain(notificationId);
  });

  it('produces a different reference for a different lifecycle', () => {
    const from = 'no-reply@example.test';
    expect(buildParticipantPreviewMessageId('a', from)).not.toBe(
      buildParticipantPreviewMessageId('b', from),
    );
  });

  it('falls back to a safe domain when the configured From address is unusable', () => {
    expect(buildParticipantPreviewMessageId('a', 'malformed-from-address')).toMatch(
      /@capstone\.invalid>$/,
    );
  });
});
