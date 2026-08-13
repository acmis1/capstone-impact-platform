import path from 'node:path';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { parseSupabaseCliEnv, isLoopbackUrl } from '../local-development/localEnvironmentFile';
import { resolveParticipantPreviewEmailConfig } from '../notifications/participantPreviewEmailConfig';
import { SmtpParticipantPreviewEmailTransport } from '../notifications/smtpParticipantPreviewEmailTransport';
import { SupabaseParticipantPreviewReminderRepositoryCore } from '../repositories/SupabaseParticipantPreviewReminderRepositoryCore';
import { isParticipantPreviewRemindersEnabled } from '../reminders/participantPreviewReminderConfig';
import { runParticipantPreviewReminders } from '../reminders/participantPreviewReminderRunner';

/**
 * Local/disposable command entrypoint. The reusable runner itself is provider-neutral; this wrapper
 * additionally refuses any non-loopback Supabase URL so an ordinary developer command cannot
 * become an accidental hosted scheduler. SMTP remains the existing server configuration boundary.
 */
export async function runLocalParticipantPreviewReminders(repoRoot = path.resolve(__dirname, '../../../..')) {
  const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
  const workdir = path.resolve(repoRoot, 'infra');
  const raw = execSync(`"${cliPath}" status --workdir "${workdir}" -o env`, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const local = parseSupabaseCliEnv(raw);
  const apiUrl = local.API_URL ?? '';
  const serviceKey = local.SERVICE_ROLE_KEY ?? '';
  if (!isLoopbackUrl(apiUrl) || !serviceKey) {
    throw new Error('Local Supabase configuration is unavailable.');
  }

  const email = resolveParticipantPreviewEmailConfig();
  if (!isParticipantPreviewRemindersEnabled() || !email.enabled) {
    return {
      code: 'DISABLED' as const,
      claimed: 0, skipped: 0, sent: 0, failed: 0,
      deliveryUnknown: 0, suppressedBeforeTransport: 0, reconciled: 0,
    };
  }

  const client = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const repository = new SupabaseParticipantPreviewReminderRepositoryCore(client);
  return runParticipantPreviewReminders({
    enabled: true,
    notifications: repository,
    transport: new SmtpParticipantPreviewEmailTransport(email.smtp),
    fromAddress: email.smtp.from,
  });
}
if (require.main === module) {
  runLocalParticipantPreviewReminders()
    .then((summary) => {
      console.log(JSON.stringify(summary));
      if (summary.code === 'RUNNER_FAILED') process.exitCode = 1;
    })
    .catch(() => {
      console.error('Participant preview reminder runner failed.');
      process.exitCode = 1;
    });
}
