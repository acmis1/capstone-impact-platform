import { describe, it, expect, vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import { SmtpParticipantPreviewEmailTransport } from './smtpParticipantPreviewEmailTransport';
import type { ParticipantPreviewEmailSmtpConfig } from './participantPreviewEmailConfig';

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

function transporterReturning(result: unknown): Transporter {
  return { sendMail: vi.fn(async () => result) } as unknown as Transporter;
}

function transporterThrowing(error: unknown): Transporter {
  return {
    sendMail: vi.fn(async () => {
      throw error;
    }),
  } as unknown as Transporter;
}

describe('SMTP participant preview transport', () => {
  it('sends exactly the composed message from the configured From address', async () => {
    const sendMail = vi.fn(async () => ({ accepted: [MESSAGE.recipient], rejected: [], messageId: MESSAGE.messageId }));
    const transport = new SmtpParticipantPreviewEmailTransport(CONFIG, {
      sendMail,
    } as unknown as Transporter);

    await transport.send(MESSAGE);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: CONFIG.from,
      to: MESSAGE.recipient,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      messageId: MESSAGE.messageId,
    });
  });

  it('reports acceptance with a bounded provider reference', async () => {
    const transport = new SmtpParticipantPreviewEmailTransport(
      CONFIG,
      transporterReturning({ accepted: [MESSAGE.recipient], rejected: [], messageId: '<server-side@local>' }),
    );

    expect(await transport.send(MESSAGE)).toEqual({
      outcome: 'accepted',
      transportReference: '<server-side@local>',
    });
  });

  it('drops an oversized or non-printable provider reference instead of storing it', async () => {
    const transport = new SmtpParticipantPreviewEmailTransport(
      CONFIG,
      transporterReturning({ accepted: [MESSAGE.recipient], rejected: [], messageId: 'x'.repeat(500) }),
    );

    const result = await transport.send(MESSAGE);
    expect(result).toEqual({ outcome: 'accepted', transportReference: MESSAGE.messageId });
  });

  it('classifies an explicitly rejected recipient', async () => {
    const transport = new SmtpParticipantPreviewEmailTransport(
      CONFIG,
      transporterReturning({ accepted: [], rejected: [MESSAGE.recipient] }),
    );

    expect(await transport.send(MESSAGE)).toEqual({
      outcome: 'rejected',
      failureCode: 'RECIPIENT_REJECTED',
    });
  });

  it('refuses to claim acceptance when the server named no accepted recipient', async () => {
    const transport = new SmtpParticipantPreviewEmailTransport(
      CONFIG,
      transporterReturning({ accepted: [], rejected: [] }),
    );

    expect(await transport.send(MESSAGE)).toEqual({ outcome: 'unknown' });
  });

  it.each([
    ['ECONNREFUSED', 'TRANSPORT_UNAVAILABLE'],
    ['EAUTH', 'TRANSPORT_UNAVAILABLE'],
    ['EDNS', 'TRANSPORT_UNAVAILABLE'],
    ['EENVELOPE', 'RECIPIENT_REJECTED'],
  ])('classifies a %s failure as %s', async (code, failureCode) => {
    const transport = new SmtpParticipantPreviewEmailTransport(
      CONFIG,
      transporterThrowing(Object.assign(new Error('smtp failure'), { code })),
    );

    expect(await transport.send(MESSAGE)).toEqual({ outcome: 'rejected', failureCode });
  });

  it.each(['ETIMEDOUT', 'ECONNRESET', 'EPIPE'])(
    'leaves a %s failure undecided rather than calling it a failure',
    async (code) => {
      const transport = new SmtpParticipantPreviewEmailTransport(
        CONFIG,
        transporterThrowing(Object.assign(new Error('interrupted'), { code })),
      );

      expect(await transport.send(MESSAGE)).toEqual({ outcome: 'unknown' });
    },
  );

  it('treats a 5xx reply as a reliable message refusal and a 4xx as undecided', async () => {
    const permanent = new SmtpParticipantPreviewEmailTransport(
      CONFIG,
      transporterThrowing(Object.assign(new Error('refused'), { responseCode: 550 })),
    );
    expect(await permanent.send(MESSAGE)).toEqual({
      outcome: 'rejected',
      failureCode: 'MESSAGE_REJECTED',
    });

    const temporary = new SmtpParticipantPreviewEmailTransport(
      CONFIG,
      transporterThrowing(Object.assign(new Error('try later'), { responseCode: 451 })),
    );
    expect(await temporary.send(MESSAGE)).toEqual({ outcome: 'unknown' });
  });

  it('never surfaces the underlying provider error text or any credential', async () => {
    const authenticated: ParticipantPreviewEmailSmtpConfig = {
      ...CONFIG,
      auth: { user: 'mailer', password: 'super-secret-password' },
    };
    const transport = new SmtpParticipantPreviewEmailTransport(
      authenticated,
      transporterThrowing(
        Object.assign(new Error('535 auth failed for user mailer with super-secret-password'), {
          code: 'EAUTH',
          response: '535 5.7.8 Authentication credentials invalid',
        }),
      ),
    );

    const serialized = JSON.stringify(await transport.send(MESSAGE));
    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('mailer');
    expect(serialized).not.toContain('535');
    expect(serialized).toContain('TRANSPORT_UNAVAILABLE');
  });
});
