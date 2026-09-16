import type { ParticipantPreviewEmailConfigResult } from './participantPreviewEmailConfig';
import type { ParticipantPreviewEmailTransport } from './participantPreviewEmailTransport';
import { SmtpParticipantPreviewEmailTransport } from './smtpParticipantPreviewEmailTransport';
import { BrevoParticipantPreviewEmailTransport } from './brevoParticipantPreviewEmailTransport';
import { Smtp2goParticipantPreviewEmailTransport } from './smtp2goParticipantPreviewEmailTransport';

export interface ParticipantPreviewEmailTransportInstance {
  transport: ParticipantPreviewEmailTransport;
  fromAddress: string;
}

/**
 * Creates the appropriate ParticipantPreviewEmailTransport based on the resolved configuration.
 *
 * Fails closed if delivery is not enabled or if configuration is invalid.
 * Preserves existing SMTP and Local sink implementations while providing
 * seamless instantiate-time routing to a configured provider-specific HTTPS transport.
 */
export function createParticipantPreviewEmailTransport(
  config: ParticipantPreviewEmailConfigResult,
): ParticipantPreviewEmailTransport {
  if (!config.enabled) {
    throw new Error('Cannot instantiate email transport when participant preview email delivery is disabled.');
  }

  if (config.provider === 'brevo') {
    return new BrevoParticipantPreviewEmailTransport(config.brevo);
  }

  if (config.provider === 'smtp2go') {
    return new Smtp2goParticipantPreviewEmailTransport(config.smtp2go);
  }

  // Default to SMTP provider
  return new SmtpParticipantPreviewEmailTransport(config.smtp);
}

/**
 * Creates both the transport and returns the authoritative From address.
 */
export function createParticipantPreviewEmailTransportWithFrom(
  config: ParticipantPreviewEmailConfigResult,
): ParticipantPreviewEmailTransportInstance {
  if (!config.enabled) {
    throw new Error('Cannot instantiate email transport when participant preview email delivery is disabled.');
  }

  const transport = createParticipantPreviewEmailTransport(config);
  const fromAddress = config.fromAddress;

  return { transport, fromAddress };
}
