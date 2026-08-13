import { describe, it, expect, vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import { SmtpParticipantPreviewEmailTransport } from './smtpParticipantPreviewEmailTransport';
import {
  executeParticipantPreviewNotification,
  type NotificationTransitionOutcome,
  type ParticipantPreviewNotificationGateway,
} from './participantPreviewNotificationService';
import type {
  ParticipantPreviewEmailMessage,
  ParticipantPreviewEmailTransport,
  ParticipantPreviewEmailTransportResult,
} from './participantPreviewEmailTransport';

const INPUT = {
  notificationId: 'n-1',
  executionToken: 'exec-token-1',
  recipient: 'group.alpha@example.invalid',
  projectTitle: 'Smart Traffic Analysis',
  previewUrl: 'https://admin.example.test/participant-preview/' + 'a'.repeat(64),
  expiresAt: '2026-08-20T10:00:00.000Z',
  fromAddress: 'no-reply@capstone.invalid',
};

/** An explicit barrier, so concurrency is asserted deterministically and never by timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface RecordingTransport extends ParticipantPreviewEmailTransport {
  calls: ParticipantPreviewEmailMessage[];
}

function makeTransport(
  result: ParticipantPreviewEmailTransportResult | (() => Promise<ParticipantPreviewEmailTransportResult>),
): RecordingTransport {
  const calls: ParticipantPreviewEmailMessage[] = [];
  return {
    calls,
    async send(message) {
      calls.push(message);
      return typeof result === 'function' ? result() : result;
    },
  };
}

function makeGateway(overrides?: Partial<ParticipantPreviewNotificationGateway>): {
  gateway: ParticipantPreviewNotificationGateway;
  finalizeCalls: Array<{ outcome: string; transportReference: string | null; failureCode: string | null }>;
} {
  const finalizeCalls: Array<{
    outcome: string;
    transportReference: string | null;
    failureCode: string | null;
  }> = [];

  const gateway: ParticipantPreviewNotificationGateway = {
    beginTransport: async (): Promise<NotificationTransitionOutcome> => ({
      resultCode: 'TRANSPORT_AUTHORIZED',
    }),
    finalize: async (_id, _token, outcome, transportReference, failureCode) => {
      finalizeCalls.push({ outcome, transportReference, failureCode });
      return { resultCode: 'FINALIZED' };
    },
    ...overrides,
  };

  return { gateway, finalizeCalls };
}

describe('participant preview notification execution', () => {
  it('crosses the transport boundary exactly once and records a reliable acceptance as sent', async () => {
    const transport = makeTransport({ outcome: 'accepted', transportReference: '<ref-1@local>' });
    const { gateway, finalizeCalls } = makeGateway();

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('SENT');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].recipient).toBe(INPUT.recipient);
    expect(transport.calls[0].text).toContain(INPUT.previewUrl);
    expect(finalizeCalls).toEqual([
      { outcome: 'sent', transportReference: '<ref-1@local>', failureCode: null },
    ]);
  });

  it('records a reliable provider refusal as failed with a bounded code', async () => {
    const transport = makeTransport({ outcome: 'rejected', failureCode: 'RECIPIENT_REJECTED' });
    const { gateway, finalizeCalls } = makeGateway();

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('DELIVERY_FAILED');
    expect(result.failureCode).toBe('RECIPIENT_REJECTED');
    expect(transport.calls).toHaveLength(1);
    expect(finalizeCalls[0]).toEqual({
      outcome: 'failed',
      transportReference: null,
      failureCode: 'RECIPIENT_REJECTED',
    });
  });

  it('reports an unclassifiable transport outcome as delivery_unknown, never as failed', async () => {
    const transport = makeTransport({ outcome: 'unknown' });
    const { gateway, finalizeCalls } = makeGateway();

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('DELIVERY_UNKNOWN');
    expect(finalizeCalls[0].outcome).toBe('delivery_unknown');
  });

  it('treats a transport that throws as ambiguous rather than as a failure', async () => {
    const transport: RecordingTransport = {
      calls: [],
      async send(message) {
        this.calls.push(message);
        throw new Error('socket closed after DATA');
      },
    };
    const { gateway, finalizeCalls } = makeGateway();

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('DELIVERY_UNKNOWN');
    expect(transport.calls).toHaveLength(1);
    expect(finalizeCalls[0].outcome).toBe('delivery_unknown');
  });

  it.each(['ECONNECTION', 'ESOCKET'])(
    'finalizes as delivery_unknown (never failed) when SMTP transport encounters generic %s error',
    async (code) => {
      const transport = new SmtpParticipantPreviewEmailTransport(
        {
          host: '127.0.0.1',
          port: 54325,
          secure: false,
          auth: null,
          from: 'no-reply@capstone.invalid',
        },
        {
          sendMail: vi.fn(async () => {
            throw Object.assign(new Error('connection/socket error'), { code });
          }),
        } as unknown as Transporter,
      );
      const { gateway, finalizeCalls } = makeGateway();

      const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

      expect(result.code).toBe('DELIVERY_UNKNOWN');
      expect(finalizeCalls[0]).toEqual({
        outcome: 'delivery_unknown',
        transportReference: null,
        failureCode: null,
      });
    },
  );

  it('becomes delivery_unknown when the accepted outcome cannot be persisted at all', async () => {
    const transport = makeTransport({ outcome: 'accepted', transportReference: '<ref-2@local>' });
    const finalize = vi.fn(async () => {
      throw new Error('database unreachable');
    });
    const { gateway } = makeGateway({ finalize });

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    // The message went out; the only honest answer is that acceptance could not be confirmed.
    expect(result.code).toBe('DELIVERY_UNKNOWN');
    expect(transport.calls).toHaveLength(1);
  });

  it('falls back to recording delivery_unknown when the sent transition is rejected', async () => {
    const transport = makeTransport({ outcome: 'accepted', transportReference: '<ref-3@local>' });
    const outcomes: string[] = [];
    const { gateway } = makeGateway({
      finalize: async (_id, _token, outcome) => {
        outcomes.push(outcome);
        return outcome === 'sent' ? { resultCode: 'INVALID_STATE' } : { resultCode: 'FINALIZED' };
      },
    });

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('DELIVERY_UNKNOWN');
    expect(outcomes).toEqual(['sent', 'delivery_unknown']);
    expect(transport.calls).toHaveLength(1);
  });

  it('reports whatever the ledger already settled on when another execution finalized first', async () => {
    const transport = makeTransport({ outcome: 'accepted' });
    const { gateway } = makeGateway({
      finalize: async () => ({ resultCode: 'ALREADY_FINALIZED', status: 'delivery_unknown' }),
    });

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);
    expect(result.code).toBe('DELIVERY_UNKNOWN');
  });
});

describe('execution ownership fencing', () => {
  it.each([
    ['EXECUTION_TOKEN_MISMATCH'],
    ['EXECUTION_LEASE_EXPIRED'],
    ['INVALID_STATE'],
  ])('sends nothing and reports IN_PROGRESS when authorization returns %s', async (resultCode) => {
    const transport = makeTransport({ outcome: 'accepted' });
    const { gateway, finalizeCalls } = makeGateway({
      beginTransport: async () => ({ resultCode }),
    });

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('IN_PROGRESS');
    expect(transport.calls).toHaveLength(0);
    // A lifecycle this execution does not own must not be mutated by it either.
    expect(finalizeCalls).toHaveLength(0);
  });

  it('a second caller sends nothing while the first still holds the lifecycle, and the first sends once', async () => {
    const barrier = deferred<void>();
    const transport = makeTransport(async () => {
      await barrier.promise;
      return { outcome: 'accepted', transportReference: '<ref-a@local>' };
    });

    let authorizations = 0;
    const { gateway, finalizeCalls } = makeGateway({
      beginTransport: async () => {
        authorizations += 1;
        // Only the first caller claims the reserved lifecycle; the second observes it in flight.
        return authorizations === 1
          ? { resultCode: 'TRANSPORT_AUTHORIZED' }
          : { resultCode: 'INVALID_STATE', status: 'transport_started' };
      },
    });

    const first = executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);
    const second = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(second.code).toBe('IN_PROGRESS');
    expect(transport.calls).toHaveLength(1);

    barrier.resolve();
    const firstResult = await first;

    expect(firstResult.code).toBe('SENT');
    expect(transport.calls).toHaveLength(1);
    expect(finalizeCalls).toEqual([
      { outcome: 'sent', transportReference: '<ref-a@local>', failureCode: null },
    ]);
  });

  it('an owner whose transport succeeded but whose finalization was fenced does not resend', async () => {
    const transport = makeTransport({ outcome: 'accepted' });
    let finalizeAttempts = 0;
    const { gateway } = makeGateway({
      finalize: async () => {
        finalizeAttempts += 1;
        // An observer already reconciled this lifecycle to delivery_unknown.
        return { resultCode: 'ALREADY_FINALIZED', status: 'delivery_unknown' };
      },
    });

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('DELIVERY_UNKNOWN');
    expect(transport.calls).toHaveLength(1);
    expect(finalizeAttempts).toBe(1);
  });
});

describe('pre-transport eligibility and rendering', () => {
  it('sends nothing when the exact preview was confirmed between reservation and transport', async () => {
    const transport = makeTransport({ outcome: 'accepted' });
    const { gateway, finalizeCalls } = makeGateway({
      beginTransport: async () => ({ resultCode: 'ALREADY_CONFIRMED' }),
    });

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('ALREADY_CONFIRMED');
    expect(transport.calls).toHaveLength(0);
    expect(finalizeCalls[0]).toEqual({
      outcome: 'failed',
      transportReference: null,
      failureCode: 'ALREADY_CONFIRMED',
    });
  });

  it('sends nothing when the exact preview became revoked, expired or superseded', async () => {
    const transport = makeTransport({ outcome: 'accepted' });
    const { gateway, finalizeCalls } = makeGateway({
      beginTransport: async () => ({ resultCode: 'PREVIEW_NOT_ELIGIBLE' }),
    });

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('PREVIEW_NOT_ELIGIBLE');
    expect(transport.calls).toHaveLength(0);
    expect(finalizeCalls[0].failureCode).toBe('PREVIEW_NOT_ELIGIBLE');
  });

  it('never reaches the transport when the transport-started boundary itself fails', async () => {
    const transport = makeTransport({ outcome: 'accepted' });
    const { gateway, finalizeCalls } = makeGateway({
      beginTransport: async () => {
        throw new Error('database unreachable');
      },
    });

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(result.code).toBe('NOTIFICATION_FAILED');
    expect(transport.calls).toHaveLength(0);
    expect(finalizeCalls[0]).toEqual({
      outcome: 'failed',
      transportReference: null,
      failureCode: 'TRANSPORT_NOT_AUTHORIZED',
    });
  });

  it('fails before the boundary rather than emailing an unsafe preview link', async () => {
    const transport = makeTransport({ outcome: 'accepted' });
    const { gateway, finalizeCalls } = makeGateway();

    const result = await executeParticipantPreviewNotification(
      { notifications: gateway, transport },
      { ...INPUT, previewUrl: 'javascript:alert(1)' },
    );

    expect(result.code).toBe('DELIVERY_FAILED');
    expect(result.failureCode).toBe('UNSAFE_PREVIEW_URL');
    expect(transport.calls).toHaveLength(0);
    expect(finalizeCalls[0].failureCode).toBe('UNSAFE_PREVIEW_URL');
  });
});

describe('credential containment', () => {
  it('keeps the secure link inside the outgoing message and out of every returned value', async () => {
    const transport = makeTransport({ outcome: 'accepted', transportReference: '<ref-4@local>' });
    const { gateway, finalizeCalls } = makeGateway();

    const result = await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    expect(JSON.stringify(result)).not.toContain(INPUT.previewUrl);
    expect(JSON.stringify(result)).not.toContain(INPUT.executionToken);
    expect(JSON.stringify(finalizeCalls)).not.toContain(INPUT.previewUrl);

    // The message itself is the one place the link legitimately appears.
    expect(transport.calls[0].html).toContain(INPUT.previewUrl);
  });

  it('never puts the execution ownership token in the message it hands to the transport', async () => {
    const transport = makeTransport({ outcome: 'accepted' });
    const { gateway } = makeGateway();

    await executeParticipantPreviewNotification({ notifications: gateway, transport }, INPUT);

    const message = JSON.stringify(transport.calls[0]);
    expect(message).not.toContain(INPUT.executionToken);
    expect(message).not.toContain(INPUT.notificationId);
  });
});
