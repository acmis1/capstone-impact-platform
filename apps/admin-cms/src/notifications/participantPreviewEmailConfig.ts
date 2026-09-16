/**
 * Server-side operational enablement and transport configuration for participant preview email.
 *
 * Fails closed in every direction. Real delivery happens only when the enablement flag is set to
 * exactly `true` AND a complete, syntactically valid selected transport configuration is present. Absent, empty,
 * partial or unparseable configuration all mean disabled — never "try anyway and see".
 *
 * None of these variables is `NEXT_PUBLIC_`-prefixed, so the browser can neither read them nor
 * influence them. Nothing here is ever echoed into an HTTP response, a log line or the delivery
 * ledger: callers receive only a bounded `EMAIL_DELIVERY_DISABLED` outcome.
 *
 * Production rollout is deliberately NOT covered by this module. Choosing an institutional provider,
 * obtaining credentials and agreeing an approved From address remain open decisions; until they are
 * made, the shipped default is disabled and SMTP2GO remains an unqualified candidate path.
 */

export const PARTICIPANT_PREVIEW_EMAIL_ENABLED_VAR = 'PARTICIPANT_PREVIEW_EMAIL_ENABLED';
export const PARTICIPANT_PREVIEW_EMAIL_PROVIDER_VAR = 'PARTICIPANT_PREVIEW_EMAIL_PROVIDER';

// SMTP transport variables
export const PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST_VAR = 'PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST';
export const PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT_VAR = 'PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT';
export const PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE_VAR = 'PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE';
export const PARTICIPANT_PREVIEW_EMAIL_SMTP_USER_VAR = 'PARTICIPANT_PREVIEW_EMAIL_SMTP_USER';
export const PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD_VAR = 'PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD';

// Shared, Brevo and SMTP2GO HTTPS transport variables
export const PARTICIPANT_PREVIEW_EMAIL_FROM_VAR = 'PARTICIPANT_PREVIEW_EMAIL_FROM';
export const PARTICIPANT_PREVIEW_EMAIL_FROM_NAME_VAR = 'PARTICIPANT_PREVIEW_EMAIL_FROM_NAME';
export const PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY_VAR = 'PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY';
export const PARTICIPANT_PREVIEW_EMAIL_BREVO_SANDBOX_VAR = 'PARTICIPANT_PREVIEW_EMAIL_BREVO_SANDBOX';
export const PARTICIPANT_PREVIEW_EMAIL_SMTP2GO_API_KEY_VAR = 'PARTICIPANT_PREVIEW_EMAIL_SMTP2GO_API_KEY';
export const PARTICIPANT_PREVIEW_EMAIL_SMTP2GO_EXACT_LINK_QUALIFIED_VAR =
  'PARTICIPANT_PREVIEW_EMAIL_SMTP2GO_EXACT_LINK_QUALIFIED';

/** A plain environment view, so the resolver stays a pure function that tests can drive directly. */
export type ParticipantPreviewEmailEnv = Record<string, string | undefined>;

export type ParticipantPreviewEmailProvider = 'smtp' | 'brevo' | 'smtp2go';

export interface ParticipantPreviewEmailSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  /** Hosted callers set this to require STARTTLS when `secure` is false. */
  requireTLS?: boolean;
  /** Present only when the server is configured to authenticate. Never logged or returned. */
  auth: { user: string; password: string } | null;
  /** RFC 5321 envelope/From address. Bounded and control-character free. */
  from: string;
}

export interface ParticipantPreviewEmailBrevoConfig {
  /** Brevo v3 API Key (xkeysib-...). Never logged or returned to clients. */
  apiKey: string;
  /** Verified sender email address. */
  from: string;
  /** Optional display name for the sender. */
  fromName?: string;
  /** Whether sandbox mode is active (drop delivery, validates API request only). */
  sandbox: boolean;
}

export interface ParticipantPreviewEmailSmtp2goConfig {
  /** SMTP2GO API key (api-...). Never logged or returned to clients. */
  apiKey: string;
  /** Verified sender email address. */
  from: string;
  /** Optional display name for the sender. */
  fromName?: string;
}

export type ParticipantPreviewEmailConfigResult =
  | {
      enabled: true;
      provider?: 'smtp';
      smtp: ParticipantPreviewEmailSmtpConfig;
      brevo?: never;
      smtp2go?: never;
      fromAddress: string;
    }
  | {
      enabled: true;
      provider: 'brevo';
      brevo: ParticipantPreviewEmailBrevoConfig;
      smtp?: never;
      smtp2go?: never;
      fromAddress: string;
    }
  | {
      enabled: true;
      provider: 'smtp2go';
      smtp2go: ParticipantPreviewEmailSmtp2goConfig;
      smtp?: never;
      brevo?: never;
      fromAddress: string;
    }
  | { enabled: false; provider?: never; smtp?: never; brevo?: never; smtp2go?: never; fromAddress?: never };

/** Only this exact value enables delivery; everything else — including absent — is disabled. */
export function isParticipantPreviewEmailEnabledValue(raw: string | undefined | null): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

function readBounded(raw: string | undefined, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > maxLength) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return value;
}

function isValidEmailAddress(value: string): boolean {
  if (value.length > 254) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain) return false;
  if (domain.indexOf('.') === -1) return false;
  return !/\s/.test(value);
}

/**
 * Resolves the complete transport configuration, or reports disabled. Partial configuration is
 * treated as disabled rather than as an error: an operator who has set only some of the variables
 * has not finished enabling delivery, and guessing the remainder would be exactly the wrong
 * behaviour for an externally observable side effect.
 */
export function resolveParticipantPreviewEmailConfig(
  env: ParticipantPreviewEmailEnv = process.env,
): ParticipantPreviewEmailConfigResult {
  if (!isParticipantPreviewEmailEnabledValue(env[PARTICIPANT_PREVIEW_EMAIL_ENABLED_VAR])) {
    return { enabled: false };
  }

  const rawProvider = env[PARTICIPANT_PREVIEW_EMAIL_PROVIDER_VAR]?.trim().toLowerCase();
  const provider =
    !rawProvider || rawProvider === 'smtp'
      ? 'smtp'
      : rawProvider === 'brevo'
        ? 'brevo'
        : rawProvider === 'smtp2go'
          ? 'smtp2go'
          : null;

  if (provider === null) {
    // Unsupported or malformed provider specified
    return { enabled: false };
  }

  if (provider === 'brevo') {
    const apiKey = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY_VAR], 512);
    const from = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_FROM_VAR], 254);
    const fromName = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_FROM_NAME_VAR], 70) ?? undefined;
    const sandbox = isParticipantPreviewEmailEnabledValue(
      env[PARTICIPANT_PREVIEW_EMAIL_BREVO_SANDBOX_VAR],
    );

    if (!apiKey || !from || !isValidEmailAddress(from)) {
      return { enabled: false };
    }

    return {
      enabled: true,
      provider: 'brevo',
      brevo: {
        apiKey,
        from,
        ...(fromName ? { fromName } : {}),
        sandbox,
      },
      fromAddress: from,
    };
  }

  if (provider === 'smtp2go') {
    const apiKey = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_SMTP2GO_API_KEY_VAR], 512);
    const from = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_FROM_VAR], 254);
    const fromName = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_FROM_NAME_VAR], 70) ?? undefined;
    const exactLinkQualified =
      env[PARTICIPANT_PREVIEW_EMAIL_SMTP2GO_EXACT_LINK_QUALIFIED_VAR] === 'true';

    // This is only an operator attestation that the external exact-link canary passed. It can
    // become stale and does not prove the provider's current API-key settings or recipient-mailbox
    // behaviour, so the provider must still be configured separately with click tracking disabled.
    if (!apiKey || !from || !isValidEmailAddress(from) || !exactLinkQualified) {
      return { enabled: false };
    }

    return {
      enabled: true,
      provider: 'smtp2go',
      smtp2go: {
        apiKey,
        from,
        ...(fromName ? { fromName } : {}),
      },
      fromAddress: from,
    };
  }

  // SMTP provider
  const host = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST_VAR], 253);
  const from = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_FROM_VAR], 254);
  const rawPort = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT_VAR], 5);
  if (!host || !from || !rawPort) return { enabled: false };

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { enabled: false };

  const user = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_SMTP_USER_VAR], 320);
  const password = readBounded(env[PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD_VAR], 512);
  // Both or neither. A username without a password would silently downgrade to an anonymous
  // connection against a server the operator believed was authenticated.
  if ((user === null) !== (password === null)) return { enabled: false };

  return {
    enabled: true,
    provider: 'smtp',
    smtp: {
      host,
      port,
      secure: isParticipantPreviewEmailEnabledValue(
        env[PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE_VAR],
      ),
      auth: user && password ? { user, password } : null,
      from,
    },
    fromAddress: from,
  };
}

export function isParticipantPreviewEmailEnabled(env: ParticipantPreviewEmailEnv = process.env): boolean {
  return resolveParticipantPreviewEmailConfig(env).enabled;
}
