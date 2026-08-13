import { escapeHtml } from '../previews/participantPreviewHtml';
import {
  formatPreviewExpiry,
  MAX_EMAIL_SUBJECT_LENGTH,
  sanitizeHeaderText,
  SCHOOL_CONTEXT,
} from './participantPreviewEmailMessage';

export interface ParticipantPreviewReminderEmailContent {
  projectTitle: string;
  expiresAt: string;
}
const SUBJECT_PREFIX = 'Reminder: please review your capstone project details';
const MAX_TITLE_IN_SUBJECT = 80;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildParticipantPreviewReminderEmailSubject(projectTitle: string): string {
  const title = truncate(sanitizeHeaderText(projectTitle), MAX_TITLE_IN_SUBJECT);
  return truncate(title ? `${SUBJECT_PREFIX}: ${title}` : SUBJECT_PREFIX, MAX_EMAIL_SUBJECT_LENGTH);
}

export function renderParticipantPreviewReminderEmailText(
  content: ParticipantPreviewReminderEmailContent,
): string {
  const title = sanitizeHeaderText(content.projectTitle) || 'your capstone project';
  const expiry = formatPreviewExpiry(content.expiresAt);
  return [
    'Hello,',
    '',
    `Your capstone project preview for "${title}" is still awaiting your response.`,
    '',
    'Please open the secure preview link from the original review email sent to your group.',
    'On that page, either confirm the project details or request corrections.',
    '',
    `The preview expires on ${expiry} (UTC).`,
    '',
    `— ${SCHOOL_CONTEXT} team`,
  ].join('\n');
}

export function renderParticipantPreviewReminderEmailHtml(
  content: ParticipantPreviewReminderEmailContent,
): string {
  const title = escapeHtml(sanitizeHeaderText(content.projectTitle) || 'your capstone project');
  const expiry = escapeHtml(formatPreviewExpiry(content.expiresAt));
  const school = escapeHtml(SCHOOL_CONTEXT);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"></head>',
    '<body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;">',
    '<p>Hello,</p>',
    `<p>Your capstone project preview for &ldquo;${title}&rdquo; is still awaiting your response.</p>`,
    '<p>Please open the secure preview link from the <strong>original review email</strong> sent to your group.</p>',
    '<p>On that page, either confirm the project details or request corrections.</p>',
    `<p>The preview expires on <strong>${expiry} (UTC)</strong>.</p>`,
    `<p>&mdash; ${school} team</p>`,
    '</body></html>',
  ].join('\n');
}
