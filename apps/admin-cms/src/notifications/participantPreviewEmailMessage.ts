import crypto from 'node:crypto';
import { escapeHtml, isSafeExternalPreviewUrl } from '../previews/participantPreviewHtml';
import { containsControlCharacter } from '../domain/participantContactEmail';

/**
 * Renders the participant-facing preview email.
 *
 * Everything that reaches this module from a project row is untrusted imported text, so every
 * interpolated value is escaped for HTML and stripped of the control characters that would let a
 * project title become an extra mail header. The rendered bodies are transient: they are handed
 * straight to the transport and never logged, never returned to the browser, and never persisted in
 * the delivery ledger.
 */

/** Bounded so a pathological imported title cannot produce an unusable or abusive subject line. */
export const MAX_EMAIL_SUBJECT_LENGTH = 160;
const MAX_TITLE_IN_SUBJECT = 90;
const SUBJECT_PREFIX = 'Please review your capstone project details';

export const SCHOOL_CONTEXT = 'RMIT Capstone Impact Project showcase';

export interface ParticipantPreviewEmailContent {
  projectTitle: string;
  previewUrl: string;
  expiresAt: string;
}

export class ParticipantPreviewEmailRenderError extends Error {
  constructor(readonly code: 'UNSAFE_PREVIEW_URL' | 'INVALID_CONTENT') {
    super(code);
    this.name = 'ParticipantPreviewEmailRenderError';
  }
}

/**
 * Collapses all whitespace runs — including CR and LF — into single spaces and removes any
 * remaining control character. This is what makes a value safe to place on a header line, and it is
 * applied before, not after, any length bound so a truncation can never end mid-escape.
 */
export function sanitizeHeaderText(value: string): string {
  let cleaned = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    cleaned += containsControlCharacter(character) ? ' ' : character;
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Human-readable UTC expiry. Never exposes a raw database timestamp format to a participant. */
export function formatPreviewExpiry(expiresAt: string): string {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    throw new ParticipantPreviewEmailRenderError('INVALID_CONTENT');
  }
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(parsed));
}

export function buildParticipantPreviewEmailSubject(projectTitle: string): string {
  const title = truncate(sanitizeHeaderText(projectTitle), MAX_TITLE_IN_SUBJECT);
  const subject = title ? `${SUBJECT_PREFIX}: ${title}` : SUBJECT_PREFIX;
  return truncate(subject, MAX_EMAIL_SUBJECT_LENGTH);
}

/**
 * A deterministic, opaque Message-ID derived from the notification's identity.
 *
 * Deliberately a one-way digest rather than the identifier itself: a Message-ID travels in message
 * headers and through mail logs the School does not control, so it must not disclose an internal
 * database identifier — and it must obviously never contain any part of the preview credential.
 * Determinism means the same lifecycle always produces the same reference, which helps diagnostics;
 * it does not and cannot make delivery exactly-once.
 */
export function buildParticipantPreviewMessageId(notificationId: string, fromAddress: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`participant-preview-notification:${notificationId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const domain = fromAddress.split('@')[1]?.trim().toLowerCase();
  const safeDomain = domain && /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : 'capstone.invalid';
  return `<pp-${digest}@${safeDomain}>`;
}

export function renderParticipantPreviewEmailText(content: ParticipantPreviewEmailContent): string {
  const title = sanitizeHeaderText(content.projectTitle) || 'your capstone project';
  const expiry = formatPreviewExpiry(content.expiresAt);

  return [
    'Hello,',
    '',
    `Your project information for "${title}" has been prepared for the ${SCHOOL_CONTEXT} and is ready for you to review.`,
    '',
    'Open your secure preview link to see exactly what would be shown:',
    content.previewUrl,
    '',
    `This link is personal to your group and stops working after ${expiry} (UTC).`,
    '',
    'On that page you can either confirm the details are correct, or request corrections by',
    'describing what needs to change. Nothing is published until your group has confirmed.',
    '',
    'If you were not expecting this message, you can safely ignore it.',
    '',
    `— ${SCHOOL_CONTEXT} team`,
  ].join('\n');
}

export function renderParticipantPreviewEmailHtml(content: ParticipantPreviewEmailContent): string {
  // Escaping alone would not make an href safe: javascript:/data: URLs still execute once escaped,
  // so the scheme is checked before the URL is allowed to become a link at all.
  if (!isSafeExternalPreviewUrl(content.previewUrl)) {
    throw new ParticipantPreviewEmailRenderError('UNSAFE_PREVIEW_URL');
  }

  const title = escapeHtml(sanitizeHeaderText(content.projectTitle) || 'your capstone project');
  const expiry = escapeHtml(formatPreviewExpiry(content.expiresAt));
  const url = escapeHtml(content.previewUrl);
  const school = escapeHtml(SCHOOL_CONTEXT);

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"></head>',
    '<body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;">',
    '<p>Hello,</p>',
    `<p>Your project information for &ldquo;${title}&rdquo; has been prepared for the ${school} and is ready for you to review.</p>`,
    '<p>Open your secure preview link to see exactly what would be shown:</p>',
    `<p><a href="${url}" style="color:#1D4ED8;">${url}</a></p>`,
    `<p>This link is personal to your group and stops working after <strong>${expiry} (UTC)</strong>.</p>`,
    '<p>On that page you can either confirm the details are correct, or request corrections by describing what needs to change. Nothing is published until your group has confirmed.</p>',
    '<p>If you were not expecting this message, you can safely ignore it.</p>',
    `<p>&mdash; ${school} team</p>`,
    '</body></html>',
  ].join('\n');
}
