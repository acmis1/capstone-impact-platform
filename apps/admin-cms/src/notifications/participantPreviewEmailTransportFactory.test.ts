import { describe, it, expect } from 'vitest';
import {
  createParticipantPreviewEmailTransport,
  createParticipantPreviewEmailTransportWithFrom,
} from './participantPreviewEmailTransportFactory';
import { SmtpParticipantPreviewEmailTransport } from './smtpParticipantPreviewEmailTransport';
import { BrevoParticipantPreviewEmailTransport } from './brevoParticipantPreviewEmailTransport';
import type { ParticipantPreviewEmailConfigResult } from './participantPreviewEmailConfig';

const SMTP_CONFIG: ParticipantPreviewEmailConfigResult = {
  enabled: true,
  provider: 'smtp',
  smtp: {
    host: '127.0.0.1',
    port: 54325,
    secure: false,
    auth: null,
    from: 'noreply@capstone.test',
  },
  fromAddress: 'noreply@capstone.test',
};

const BREVO_CONFIG: ParticipantPreviewEmailConfigResult = {
  enabled: true,
  provider: 'brevo',
  brevo: {
    apiKey: 'xkeysib-test-12345',
    from: 'brevo-sender@capstone.test',
    fromName: 'Capstone Impact',
    sandbox: false,
  },
  fromAddress: 'brevo-sender@capstone.test',
};

describe('participantPreviewEmailTransportFactory', () => {
  it('throws an error if configuration is disabled', () => {
    expect(() => {
      createParticipantPreviewEmailTransport({ enabled: false });
    }).toThrow(/Cannot instantiate email transport/);

    expect(() => {
      createParticipantPreviewEmailTransportWithFrom({ enabled: false });
    }).toThrow(/Cannot instantiate email transport/);
  });

  it('creates an SmtpParticipantPreviewEmailTransport for SMTP config', () => {
    const transport = createParticipantPreviewEmailTransport(SMTP_CONFIG);
    expect(transport).toBeInstanceOf(SmtpParticipantPreviewEmailTransport);

    const withFrom = createParticipantPreviewEmailTransportWithFrom(SMTP_CONFIG);
    expect(withFrom.transport).toBeInstanceOf(SmtpParticipantPreviewEmailTransport);
    expect(withFrom.fromAddress).toBe('noreply@capstone.test');
  });

  it('creates a BrevoParticipantPreviewEmailTransport for Brevo config', () => {
    const transport = createParticipantPreviewEmailTransport(BREVO_CONFIG);
    expect(transport).toBeInstanceOf(BrevoParticipantPreviewEmailTransport);

    const withFrom = createParticipantPreviewEmailTransportWithFrom(BREVO_CONFIG);
    expect(withFrom.transport).toBeInstanceOf(BrevoParticipantPreviewEmailTransport);
    expect(withFrom.fromAddress).toBe('brevo-sender@capstone.test');
  });
});
