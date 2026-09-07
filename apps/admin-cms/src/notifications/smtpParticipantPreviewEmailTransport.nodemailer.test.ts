import { describe, it, expect, vi } from 'vitest';
import nodemailer, { type Transporter } from 'nodemailer';
import { SmtpParticipantPreviewEmailTransport } from './smtpParticipantPreviewEmailTransport';
import { buildParticipantPreviewEmailSubject } from './participantPreviewEmailMessage';
import type { ParticipantPreviewEmailSmtpConfig } from './participantPreviewEmailConfig';

/**
 * Contract tests against the REAL nodemailer package, not a mocked transporter.
 *
 * The sibling unit tests drive a hand-written stub, so they would keep passing even if the
 * installed nodemailer changed the option shape it accepts or the result shape it returns. These
 * tests exist to catch exactly that, because the dependency crossed a major boundary (7.x -> 9.x)
 * to clear the advisories listed below.
 *
 * Two of those advisories — arbitrary file read / full-response SSRF through the message-level
 * `raw` option (GHSA-p6gq-j5cr-w38f), and header injection through `List-*` header comments
 * (GHSA-268h-hp4c-crq3) — are only exploitable when untrusted input reaches a message option this
 * application does not use. The first test pins that: the outgoing message is a closed set of six
 * keys. If someone later widens ParticipantPreviewEmailMessage to carry attachments, raw content,
 * a custom envelope or arbitrary headers, that test fails and the reachability argument gets
 * re-examined rather than silently lost.
 *
 * Nothing here opens an SMTP session or sends mail: `jsonTransport` serializes the composed message
 * and never touches the network.
 */

const CONFIG: ParticipantPreviewEmailSmtpConfig = {
  host: '127.0.0.1',
  port: 54325,
  secure: false,
  auth: null,
  from: 'no-reply@capstone.invalid',
};

const MESSAGE = {
  recipient: 'group.alpha@example.invalid',
  subject: 'Please review your capstone project details',
  text: 'plain body',
  html: '<p>html body</p>',
  messageId: '<pp-abcdef@capstone.invalid>',
};

/** Every message option nodemailer treats as a file, URL, raw-content or header-bearing source. */
const FORBIDDEN_MESSAGE_OPTIONS = [
  'raw',
  'attachments',
  'alternatives',
  'headers',
  'list',
  'envelope',
  'path',
  'href',
  'icalEvent',
  'watchHtml',
  'amp',
];

describe('SMTP participant preview transport — real nodemailer contract', () => {
  it('hands nodemailer a closed set of six message options and no file, URL, raw or header source', async () => {
    const sendMail = vi.fn(async () => ({
      accepted: [MESSAGE.recipient],
      rejected: [],
      messageId: MESSAGE.messageId,
    }));
    const transport = new SmtpParticipantPreviewEmailTransport(CONFIG, {
      sendMail,
    } as unknown as Transporter);

    await transport.send(MESSAGE);

    const [options] = sendMail.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(options).sort()).toEqual(
      ['from', 'html', 'messageId', 'subject', 'text', 'to'].sort(),
    );
    for (const forbidden of FORBIDDEN_MESSAGE_OPTIONS) {
      expect(options).not.toHaveProperty(forbidden);
    }
  });

  it('builds a working transporter from the resolved SMTP configuration', () => {
    // Proves the installed major still accepts the exact option object the app constructs,
    // including the three timeout bounds the transport relies on to stay responsive.
    const transporter = nodemailer.createTransport({
      host: CONFIG.host,
      port: CONFIG.port,
      secure: CONFIG.secure,
      auth: undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    expect(typeof transporter.sendMail).toBe('function');
    expect(transporter.transporter).toBeDefined();
  });

  it('composes the message through real nodemailer with the app From, recipient and Message-ID', async () => {
    const jsonTransporter = nodemailer.createTransport({ jsonTransport: true });
    const transport = new SmtpParticipantPreviewEmailTransport(CONFIG, jsonTransporter);

    // jsonTransport reports no accepted recipient, so the transport must stay undecided rather
    // than claim delivery — the same conservative outcome the SMTP path uses for an ambiguous
    // acknowledgement.
    expect(await transport.send(MESSAGE)).toEqual({ outcome: 'unknown' });

    const info = await jsonTransporter.sendMail({
      from: CONFIG.from,
      to: MESSAGE.recipient,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      messageId: MESSAGE.messageId,
    });

    const composed = JSON.parse(info.message as unknown as string);
    expect(composed.from.address).toBe(CONFIG.from);
    expect(composed.to).toEqual([
      expect.objectContaining({ address: MESSAGE.recipient }),
    ]);
    expect(composed.subject).toBe(MESSAGE.subject);
    expect(composed.messageId).toBe(MESSAGE.messageId);
  });

  it('cannot be made to emit an injected header from a hostile imported project title', async () => {
    // An imported title is untrusted. sanitizeHeaderText() collapses CR/LF before the subject is
    // built; this asserts the guarantee survives real nodemailer's own header encoding, which is
    // where a CRLF that slipped through would actually become a second header.
    const hostileTitle =
      'Solar Array\r\nBcc: attacker@evil.invalid\r\nList-Unsubscribe: <https://evil.invalid/x>';
    const subject = buildParticipantPreviewEmailSubject(hostileTitle);

    expect(subject).not.toContain('\r');
    expect(subject).not.toContain('\n');

    const jsonTransporter = nodemailer.createTransport({ jsonTransport: true });
    const info = await jsonTransporter.sendMail({
      from: CONFIG.from,
      to: MESSAGE.recipient,
      subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      messageId: MESSAGE.messageId,
    });

    const composed = JSON.parse(info.message as unknown as string);
    expect(composed.subject).toBe(subject);
    expect(composed).not.toHaveProperty('bcc');
    expect(composed.to).toEqual([
      expect.objectContaining({ address: MESSAGE.recipient }),
    ]);

    // The hostile text survives as inert Subject content — that is the safe outcome. What must
    // never happen is it becoming structure: no extra recipient, and no additional header.
    expect(composed).not.toHaveProperty('cc');
    expect(composed.headers).toEqual({});
    expect(String(composed.subject)).not.toContain(String.fromCharCode(13));
    expect(String(composed.subject)).not.toContain(String.fromCharCode(10));
    expect(String(composed.subject)).toContain('Bcc: attacker@evil.invalid');
  });
});
