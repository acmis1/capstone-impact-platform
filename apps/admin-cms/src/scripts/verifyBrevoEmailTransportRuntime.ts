import crypto from 'node:crypto';
import {
  resolveParticipantPreviewEmailConfig,
  type ParticipantPreviewEmailEnv,
} from '../notifications/participantPreviewEmailConfig';
import {
  BrevoParticipantPreviewEmailTransport,
  BREVO_TRANSACTIONAL_EMAIL_ENDPOINT,
} from '../notifications/brevoParticipantPreviewEmailTransport';
import type { ParticipantPreviewEmailMessage } from '../notifications/participantPreviewEmailTransport';

export interface OperatorVerificationOptions {
  env?: ParticipantPreviewEmailEnv;
  args?: string[];
  fetchFn?: typeof fetch;
  endpoint?: string;
  skipCiCheck?: boolean;
}

export type OperatorVerificationOutcome =
  | 'OPT_IN_REQUIRED'
  | 'PREREQUISITES_MISSING'
  | 'RECIPIENT_NOT_ALLOWLISTED'
  | 'BLOCKED_IN_CI'
  | 'ACCEPTED'
  | 'SANDBOX_NO_DELIVERY'
  | 'REJECTED'
  | 'UNKNOWN';

export interface OperatorVerificationResult {
  outcome: OperatorVerificationOutcome;
  message: string;
  referenceFingerprint?: string;
  failureCode?: string;
  details?: Record<string, unknown>;
}

/**
 * Checks whether the recipient is explicitly permitted for verification.
 * For live sends: MUST match an entry in explicitAllowlist exactly. No domain wildcards.
 * For sandbox sends: synthetic example domains are permitted as delivery is dropped upstream.
 */
export function isAllowlistedRecipient(
  recipient: string,
  explicitAllowlist: string[] = [],
  isSandbox: boolean = false,
): boolean {
  const normalized = recipient.trim().toLowerCase();
  if (!normalized) return false;
  if (explicitAllowlist.some((allowed) => allowed.trim().toLowerCase() === normalized)) {
    return true;
  }
  if (isSandbox) {
    const domain = normalized.split('@')[1];
    if (!domain) return false;
    return domain === 'example.test' || domain === 'example.com' || domain === 'capstone.internal';
  }
  return false;
}

/**
 * Standalone operator-verification command for Brevo HTTPS email transport.
 *
 * Designed to strictly isolate operator manual qualification from automated test suites,
 * continuous integration, and production builds.
 */
export async function runBrevoEmailTransportVerification(
  options: OperatorVerificationOptions = {},
): Promise<OperatorVerificationResult> {
  const env = options.env ?? process.env;
  const args = options.args ?? process.argv.slice(2);

  // Safety Gate 1: Refuse to execute during CI environments unless explicitly bypassed in unit tests
  const isCi = Boolean(env.CI || env.GITHUB_ACTIONS);
  if (isCi && !options.skipCiCheck) {
    return {
      outcome: 'BLOCKED_IN_CI',
      message: 'Operator verification command is prohibited from executing within CI environments.',
    };
  }

  // Safety Gate 2: Validate provider configuration and account prerequisites early
  const emailConfig = resolveParticipantPreviewEmailConfig(env);
  if (!emailConfig.enabled || emailConfig.provider !== 'brevo') {
    return {
      outcome: 'PREREQUISITES_MISSING',
      message: 'Brevo HTTPS email provider is not enabled or incomplete in environment.',
      details: {
        requiredVariables: [
          'PARTICIPANT_PREVIEW_EMAIL_ENABLED=true',
          'PARTICIPANT_PREVIEW_EMAIL_PROVIDER=brevo',
          'PARTICIPANT_PREVIEW_EMAIL_BREVO_API_KEY=<xkeysib-...>',
          'PARTICIPANT_PREVIEW_EMAIL_FROM=<verified-sender@domain>',
        ],
        optionalVariables: [
          'PARTICIPANT_PREVIEW_EMAIL_FROM_NAME="Capstone Impact Platform"',
          'PARTICIPANT_PREVIEW_EMAIL_BREVO_SANDBOX=true',
        ],
      },
    };
  }

  const isSandbox = Boolean(emailConfig.brevo.sandbox);

  // Safety Gate 3: Explicit opt-in requirement
  // Live sending requires command-line --opt-in-real-send (environment-only opt-in is prohibited for real sends)
  const hasCommandLineOptIn = args.includes('--opt-in-real-send');
  if (!isSandbox && !hasCommandLineOptIn) {
    return {
      outcome: 'OPT_IN_REQUIRED',
      message:
        'Live email verification requires explicit command-line opt-in via --opt-in-real-send.',
      details: {
        usage:
          'npx tsx verifyBrevoEmailTransportRuntime.ts --opt-in-real-send --recipient <team-mailbox@example.com>',
      },
    };
  }

  const hasSandboxOptIn =
    hasCommandLineOptIn ||
    args.includes('--opt-in') ||
    args.includes('--sandbox') ||
    env.BREVO_OPERATOR_VERIFICATION_OPT_IN === 'true';

  if (isSandbox && !hasSandboxOptIn) {
    return {
      outcome: 'OPT_IN_REQUIRED',
      message:
        'Sandbox verification requires explicit opt-in via --opt-in-real-send, --sandbox, or BREVO_OPERATOR_VERIFICATION_OPT_IN=true.',
    };
  }

  // Safety Gate 4: Resolve and check target recipient allowlist
  let recipient = '';
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--recipient' || args[i] === '--to') && args[i + 1]) {
      recipient = args[i + 1].trim();
      break;
    }
  }
  if (!recipient && env.BREVO_VERIFICATION_RECIPIENT) {
    recipient = env.BREVO_VERIFICATION_RECIPIENT.trim();
  }

  const explicitAllowlist = (env.BREVO_VERIFICATION_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // In live mode, we do NOT silently default recipient to From address unless that exact address is explicitly allowlisted
  if (!recipient && isSandbox) {
    recipient = 'test-sandbox@example.test';
  } else if (!recipient && isAllowlistedRecipient(emailConfig.fromAddress, explicitAllowlist, false)) {
    recipient = emailConfig.fromAddress;
  }

  if (!recipient || !isAllowlistedRecipient(recipient, explicitAllowlist, isSandbox)) {
    return {
      outcome: 'RECIPIENT_NOT_ALLOWLISTED',
      message: 'Target recipient is not on the explicit verification allowlist.',
    };
  }

  // Assemble safe synthetic message
  const timestamp = new Date().toISOString();
  const runId = crypto.randomBytes(6).toString('hex');
  const syntheticMessage: ParticipantPreviewEmailMessage = {
    recipient,
    subject: `[Operator Verification ${runId}] Capstone Platform Email Delivery Check`,
    text: [
      'Hello from Capstone Impact Platform Operator Verification.',
      '',
      `Verification run ID: ${runId}`,
      `Timestamp: ${timestamp}`,
      `Target: ${recipient}`,
      '',
      'This is an operator verification check for Brevo HTTPS email delivery.',
      'If you received this message, please verify that sender details are as expected.',
    ].join('\n'),
    html: [
      '<!doctype html><html><body>',
      '<h2>Capstone Impact Platform Operator Verification</h2>',
      `<p><strong>Run ID:</strong> ${runId}</p>`,
      `<p><strong>Timestamp:</strong> ${timestamp}</p>`,
      `<p><strong>Target Recipient:</strong> ${recipient}</p>`,
      '<p>This email confirms connectivity and dispatch through Brevo HTTPS transactional transport.</p>',
      '</body></html>',
    ].join('\n'),
    messageId: `<operator-verify-${runId}@${emailConfig.fromAddress.split('@')[1] ?? 'capstone.internal'}>`,
  };

  const transport = new BrevoParticipantPreviewEmailTransport(emailConfig.brevo, {
    endpoint: options.endpoint ?? BREVO_TRANSACTIONAL_EMAIL_ENDPOINT,
    fetchFn: options.fetchFn,
  });

  const sendResult = await transport.send(syntheticMessage);

  if (sendResult.outcome === 'accepted') {
    const referenceFingerprint = sendResult.transportReference
      ? crypto.createHash('sha256').update(sendResult.transportReference).digest('hex').slice(0, 12)
      : undefined;

    const isSandboxResult =
      isSandbox ||
      (sendResult.transportReference &&
        sendResult.transportReference.startsWith('SANDBOX_NO_DELIVERY'));

    if (isSandboxResult) {
      return {
        outcome: 'SANDBOX_NO_DELIVERY',
        message:
          'Brevo sandbox accepted the request; delivery dropped at provider per sandbox configuration.',
        referenceFingerprint,
        details: {
          deliveryEffect: 'SANDBOX_DROPPED_NO_DELIVERY',
        },
      };
    }

    return {
      outcome: 'ACCEPTED',
      message: 'Brevo transactional HTTPS transport accepted the message for delivery.',
      referenceFingerprint,
      details: {
        deliveryEffect: 'ACCEPTED_FOR_TRANSMISSION',
      },
    };
  }

  if (sendResult.outcome === 'rejected') {
    return {
      outcome: 'REJECTED',
      message: `Brevo transport rejected the message with failure code: ${sendResult.failureCode}`,
      failureCode: sendResult.failureCode,
    };
  }

  return {
    outcome: 'UNKNOWN',
    message: 'Brevo transport returned an unknown outcome. Check network connectivity or provider status.',
  };
}

/* Standalone CLI execution entrypoint */
if (require.main === module) {
  runBrevoEmailTransportVerification()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.outcome === 'ACCEPTED' || result.outcome === 'SANDBOX_NO_DELIVERY') {
        process.exitCode = 0;
      } else {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('Operator verification script encountered an unexpected error:', err);
      process.exitCode = 1;
    });
}
