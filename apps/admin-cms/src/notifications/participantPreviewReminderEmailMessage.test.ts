import { describe, expect, it } from 'vitest';
import {
  buildParticipantPreviewReminderEmailSubject,
  renderParticipantPreviewReminderEmailHtml,
  renderParticipantPreviewReminderEmailText,
} from './participantPreviewReminderEmailMessage';
import { MAX_EMAIL_SUBJECT_LENGTH } from './participantPreviewEmailMessage';

describe('participant preview reminder email message', () => {
  const content = {
    projectTitle: 'Safe & useful <project>',
    expiresAt: '2026-08-20T04:30:00.000Z',
  };

  it('instructs the participant to use the original email and includes expiry in both bodies', () => {
    const text = renderParticipantPreviewReminderEmailText(content);
    const html = renderParticipantPreviewReminderEmailHtml(content);
    expect(text).toContain('original review email');
    expect(html).toContain('original review email');
    expect(text).toContain('20 August 2026');
    expect(html).toContain('20 August 2026');
    expect(text).toContain('confirm the project details or request corrections');
  });

  it('has no URL-shaped input and renders no link or participant-preview path', () => {
    const rendered = [
      renderParticipantPreviewReminderEmailText(content),
      renderParticipantPreviewReminderEmailHtml(content),
    ].join('\n');
    expect(rendered).not.toMatch(/https?:\/\//i);
    expect(rendered).not.toContain('/participant-preview/');
    expect(rendered).not.toContain('<a ');
  });

  it('escapes untrusted project text in HTML', () => {
    const html = renderParticipantPreviewReminderEmailHtml({
      ...content,
      projectTitle: '<img src=x onerror=alert(1)> & project',
    });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; project');
    expect(html).not.toContain('<img');
  });

  it('sanitizes CRLF and bounds the subject', () => {
    const subject = buildParticipantPreviewReminderEmailSubject(
      `Project\r\nBcc: attacker@capstone.invalid ${'x'.repeat(300)}`,
    );
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject.length).toBeLessThanOrEqual(MAX_EMAIL_SUBJECT_LENGTH);
    expect(subject.startsWith('Reminder:')).toBe(true);
  });
});
