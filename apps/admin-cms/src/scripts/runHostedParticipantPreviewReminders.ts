import { createClient } from '@supabase/supabase-js';
import { SmtpParticipantPreviewEmailTransport } from '../notifications/smtpParticipantPreviewEmailTransport';
import { SupabaseParticipantPreviewReminderRepositoryCore } from '../repositories/SupabaseParticipantPreviewReminderRepositoryCore';
import {
  resolveHostedParticipantPreviewReminderConfig,
  type HostedParticipantPreviewReminderEnvironment,
} from '../reminders/hostedParticipantPreviewReminderConfig';
import { formatHostedParticipantPreviewReminderLog } from '../reminders/hostedParticipantPreviewReminderLog';
import {
  runHostedParticipantPreviewReminderLoop,
  type HostedParticipantPreviewReminderWait,
} from '../reminders/hostedParticipantPreviewReminderLoop';
import { runParticipantPreviewReminders } from '../reminders/participantPreviewReminderRunner';

export interface HostedParticipantPreviewReminderRunOptions {
  env?: HostedParticipantPreviewReminderEnvironment;
  signal?: AbortSignal;
  wait?: HostedParticipantPreviewReminderWait;
}

export type HostedParticipantPreviewReminderRunOutcome =
  | 'DISABLED'
  | 'CONFIGURATION_INVALID'
  | 'STOPPED';

function newAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Hosted, provider-neutral composition root. It has no HTTP server or listening socket. */
export async function runHostedParticipantPreviewReminders(
  options: HostedParticipantPreviewReminderRunOptions = {},
): Promise<HostedParticipantPreviewReminderRunOutcome> {
  const config = resolveHostedParticipantPreviewReminderConfig(options.env ?? process.env);
  const signal = options.signal ?? newAbortSignal();

  if (config.state === 'CONFIGURATION_INVALID') {
    console.error(formatHostedParticipantPreviewReminderLog(config));
    return 'CONFIGURATION_INVALID';
  }

  if (config.state === 'DISABLED') {
    console.log(formatHostedParticipantPreviewReminderLog(config));
    await runHostedParticipantPreviewReminderLoop({
      signal,
      enabled: false,
      pollIntervalMs: config.pollIntervalMs,
      wait: options.wait,
    });
    if (signal.aborted) {
      console.log(formatHostedParticipantPreviewReminderLog({ state: 'STOPPED' }));
    }
    return 'DISABLED';
  }

  if (signal.aborted) return 'STOPPED';

  const client = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const notifications = new SupabaseParticipantPreviewReminderRepositoryCore(client);
  const transport = new SmtpParticipantPreviewEmailTransport(config.smtp);

  console.log(formatHostedParticipantPreviewReminderLog({
    state: 'STARTED',
    pollIntervalMs: config.pollIntervalMs,
    batchLimit: config.batchLimit,
  }));

  await runHostedParticipantPreviewReminderLoop({
    signal,
    enabled: true,
    pollIntervalMs: config.pollIntervalMs,
    wait: options.wait,
    runOnce: () => runParticipantPreviewReminders({
      enabled: true,
      notifications,
      transport,
      fromAddress: config.fromAddress,
      batchLimit: config.batchLimit,
    }),
    report: (result) => {
      console.log(formatHostedParticipantPreviewReminderLog({ state: 'RESULT', result }));
    },
  });

  console.log(formatHostedParticipantPreviewReminderLog({ state: 'STOPPED' }));
  return 'STOPPED';
}

if (require.main === module) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  runHostedParticipantPreviewReminders({ signal: controller.signal })
    .then((outcome) => {
      if (outcome === 'CONFIGURATION_INVALID') process.exitCode = 1;
    })
    .catch(() => {
      console.error(formatHostedParticipantPreviewReminderLog({ state: 'LOOP_FAILED' }));
      process.exitCode = 1;
    });
}
