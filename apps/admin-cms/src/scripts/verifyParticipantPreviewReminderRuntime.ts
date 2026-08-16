import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { SupabaseParticipantPreviewReminderRepositoryCore } from '../repositories/SupabaseParticipantPreviewReminderRepositoryCore';
import { executeParticipantPreviewNotification } from '../notifications/participantPreviewNotificationService';
import { SmtpParticipantPreviewEmailTransport } from '../notifications/smtpParticipantPreviewEmailTransport';
import type { ParticipantPreviewEmailSmtpConfig } from '../notifications/participantPreviewEmailConfig';
import { runParticipantPreviewReminders } from '../reminders/participantPreviewReminderRunner';

const PRIVATE_BUCKET = 'project-drafts-private';
const LOCAL_DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const MAIL_API = 'http://127.0.0.1:54324/api/v1';
const SMTP: ParticipantPreviewEmailSmtpConfig = {
  host: '127.0.0.1', port: 54325, secure: false, auth: null,
  from: 'no-reply@capstone.invalid',
};

interface MailMessage { ID: string; Subject: string; To: Array<{ Address: string }> }

function token() { return crypto.randomBytes(32).toString('hex'); }
function hash(raw: string) { return crypto.createHash('sha256').update(raw, 'utf8').digest('hex'); }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitUntil(probe: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for deterministic database barrier.');
    await delay(50);
  }
}

export async function runParticipantPreviewReminderRuntimeVerification(options?: {
  repoRoot?: string;
}): Promise<boolean> {
  console.log('=== Local Participant Preview Reminder Runtime Verification ===\n');
  const repoRoot = options?.repoRoot ?? path.resolve(__dirname, '../../../..');
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const prefix = `ppr-${runId}`;
  const address = (name: string) => `${prefix}-${name}@capstone.invalid`;
  let scenarios = 0;
  let success = true;
  let client: SupabaseClient | null = null;
  const authUsers: string[] = [];

  const check = (condition: boolean, name: string) => {
    scenarios += 1;
    if (condition) console.log(`PASS: ${name}`);
    else { success = false; console.error(`FAIL: ${name}`); }
  };

  try {
    const cli = path.resolve(repoRoot, 'node_modules/.bin/supabase');
    const raw = execSync(`"${cli}" status --workdir "${path.resolve(repoRoot, 'infra')}" -o env`, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const env = parseSupabaseCliEnv(raw);
    const apiUrl = env.API_URL ?? '';
    const serviceKey = env.SERVICE_ROLE_KEY ?? '';
    const anonKey = env.ANON_KEY ?? '';
    client = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const adminClient = client;
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const repository = new SupabaseParticipantPreviewReminderRepositoryCore(adminClient);
    const smtp = new SmtpParticipantPreviewEmailTransport(SMTP);
    const psql = (sql: string) => execFileSync(
      'docker',
      ['exec', LOCAL_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();

    const { data: roles } = await adminClient.from('user_roles').select('user_id,role');
    const actor = (role: string) => String(roles?.find((row) => row.role === role)?.user_id ?? '');
    const adminId = actor('admin');
    const reviewerId = actor('reviewer');
    const editorId = actor('editor');
    if (!adminId || !reviewerId || !editorId) throw new Error('Local staff fixtures unavailable.');

    const createProject = async (name: string, recipient = address(name)) => {
      const { data, error } = await adminClient.from('projects').insert({
        public_id: `${prefix}-${name}`,
        title: `Reminder Runtime ${name}`,
        summary: 'Synthetic reminder runtime fixture.', year: 2026, status: 'approved',
        participant_contact_email: recipient,
        poster_text_public: 'Synthetic reminder runtime poster full text.',
        accessibility_text_public: 'Synthetic reminder runtime accessibility text.',
      }).select('id,public_id,title,status,participant_contact_email').single();
      if (error || !data) throw new Error('Project fixture creation failed.');
      return data;
    };

    const generateInitial = async (
      project: Awaited<ReturnType<typeof createProject>>,
      actorId = adminId,
      delivery: 'send' | 'failed' | 'unknown' | 'none' = 'send',
    ) => {
      const rawToken = token();
      if (delivery === 'none') {
        const { data, error } = await adminClient.rpc('generate_participant_preview', {
          p_public_id: project.public_id, p_admin_id: actorId, p_token_hash: hash(rawToken),
          p_expires_in_seconds: null, p_private_bucket: PRIVATE_BUCKET,
          p_is_correction_reissue: false,
        });
        if (error) throw new Error('Preview fixture creation failed.');
        return { rawToken, previewId: String((data as Record<string, unknown>).previewId), generated: null };
      }
      const generated = await repository.generatePreviewWithNotification({
        publicId: project.public_id, adminId: actorId, tokenHash: hash(rawToken),
        privateBucket: PRIVATE_BUCKET,
      });
      if (generated.resultCode !== 'SUCCESS') throw new Error('Initial notification reservation failed.');
      const value = generated.value;
      if (delivery === 'send') {
        await executeParticipantPreviewNotification(
          { notifications: repository, transport: smtp },
          {
            notificationId: value.notificationId, executionToken: value.executionToken,
            recipient: value.recipient, projectTitle: value.projectTitle,
            previewUrl: `http://localhost:3000/participant-preview/${rawToken}`,
            expiresAt: value.expiresAt, fromAddress: SMTP.from,
          },
        );
      } else if (delivery === 'unknown') {
        await repository.beginTransport(value.notificationId, value.executionToken);
        await repository.finalize(value.notificationId, value.executionToken, 'delivery_unknown', null, null);
      } else {
        await repository.finalize(
          value.notificationId, value.executionToken, 'failed', null, 'TRANSPORT_NOT_STARTED',
        );
      }
      return { rawToken, previewId: value.previewId, generated: value };
    };

    const schedule = (project: Awaited<ReturnType<typeof createProject>>, actorId: string, when: Date) =>
      repository.schedule({ publicId: project.public_id, adminId: actorId, scheduledFor: when.toISOString() });

    const scheduleRow = async (reference: string) => {
      const { data } = await adminClient.from('participant_preview_reminder_schedules')
        .select('id,project_id,participant_preview_id,initial_notification_id,recipient_email_snapshot,scheduled_for,scheduled_by_admin_id,status,skip_reason,triggered_at,cancelled_at')
        .eq('staff_reference', reference).single();
      return data;
    };

    const reminderNotification = async (scheduleId: string) => {
      const { data } = await adminClient.from('participant_preview_notifications')
        .select('id,project_id,participant_preview_id,notification_kind,reminder_schedule_id,recipient_email_snapshot,status,requested_at,sent_at,failure_code')
        .eq('reminder_schedule_id', scheduleId).maybeSingle();
      return data;
    };

    const mailbox = async (recipient: string): Promise<MailMessage[]> => {
      const response = await fetch(`${MAIL_API}/search?query=${encodeURIComponent(`to:${recipient}`)}`);
      if (!response.ok) throw new Error('Local mail sink unavailable.');
      return ((await response.json()) as { messages?: MailMessage[] }).messages ?? [];
    };

    const mailBody = async (id: string) => {
      const response = await fetch(`${MAIL_API}/message/${encodeURIComponent(id)}`);
      const message = await response.json() as { HTML?: string; Text?: string };
      return `${message.HTML ?? ''}\n${message.Text ?? ''}`;
    };

    // Scheduling prerequisites, authority, time bounds, and duplicate convergence.
    const primary = await createProject('primary');
    const primaryInitial = await generateInitial(primary);
    const futureA = new Date(Date.now() + 60_000);
    const adminSchedule = await schedule(primary, adminId, futureA);
    check(adminSchedule.resultCode === 'SCHEDULED', 'Admin can schedule an explicit future reminder');
    const primaryRow = await scheduleRow(adminSchedule.reference ?? '');
    check(primaryRow?.participant_preview_id === primaryInitial.previewId, 'Schedule binds the exact preview');
    check(primaryRow?.initial_notification_id === primaryInitial.generated?.notificationId, 'Schedule binds the successful initial notification');
    check(primaryRow?.recipient_email_snapshot === primary.participant_contact_email, 'Schedule snapshots the authoritative initial recipient');
    check(primaryRow?.scheduled_by_admin_id === adminId, 'Scheduling actor is server-controlled durable state');
    const duplicate = await schedule(primary, adminId, futureA);
    check(duplicate.resultCode === 'ALREADY_SCHEDULED' && duplicate.reference === adminSchedule.reference, 'Sequential duplicate scheduling converges');
    const concurrentAt = new Date(Date.now() + 70_000);
    const lockExpression = 'pg_catalog.hashtextextended(' +
      `'capstone.participant_preview_reminder:${primaryInitial.previewId}:' || ` +
      `'${concurrentAt.toISOString()}'::timestamptz::text, 0)`;
    const lockHolder = spawn(
      'docker',
      ['exec', LOCAL_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
        `SELECT pg_catalog.pg_advisory_lock(${lockExpression}); SELECT pg_catalog.pg_sleep(5);`],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    const lockHolderDone = new Promise<void>((resolve, reject) => {
      lockHolder.once('error', reject);
      lockHolder.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Barrier process failed.')));
    });
    await waitUntil(() => psql(
      `SELECT CASE WHEN pg_catalog.pg_try_advisory_lock(${lockExpression}) ` +
      `THEN pg_catalog.pg_advisory_unlock(${lockExpression})::text ELSE 'held' END;`,
    ) === 'held');
    const scheduleA = schedule(primary, adminId, concurrentAt);
    await waitUntil(() => Number(psql(
      "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid <> pg_catalog.pg_backend_pid() " +
      "AND state = 'active' AND query LIKE '%schedule_participant_preview_reminder%';",
    )) >= 1);
    const scheduleB = schedule(primary, adminId, concurrentAt);
    await waitUntil(() => Number(psql(
      "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid <> pg_catalog.pg_backend_pid() " +
      "AND state = 'active' AND query LIKE '%schedule_participant_preview_reminder%';",
    )) >= 2);
    await lockHolderDone;
    const concurrentSchedules = await Promise.all([scheduleA, scheduleB]);
    const concurrentRows = await adminClient.from('participant_preview_reminder_schedules')
      .select('id', { count: 'exact', head: true })
      .eq('participant_preview_id', primaryInitial.previewId)
      .eq('scheduled_for', concurrentAt.toISOString());
    check(
      concurrentSchedules.filter((row) => ['SCHEDULED', 'ALREADY_SCHEDULED'].includes(row.resultCode)).length === 2 &&
      concurrentRows.count === 1,
      'Deterministic concurrent scheduling barrier converges to one durable schedule',
    );
    const reviewerSchedule = await schedule(primary, reviewerId, new Date(Date.now() + 80_000));
    check(reviewerSchedule.resultCode === 'SCHEDULED', 'Reviewer can schedule under current participant-preview authority');
    const editorSchedule = await schedule(primary, editorId, new Date(Date.now() + 90_000));
    check(editorSchedule.resultCode === 'PREVIEW_PERMISSION_DENIED', 'Editor-only actor cannot schedule');
    const past = await schedule(primary, adminId, new Date(Date.now() - 1000));
    check(past.resultCode === 'SCHEDULE_NOT_FUTURE', 'Past schedule time is rejected');
    const afterExpiry = await schedule(primary, adminId, new Date(Date.parse(primaryInitial.generated!.expiresAt) + 1000));
    check(afterExpiry.resultCode === 'SCHEDULE_AFTER_EXPIRY', 'Time at or after exact preview expiry is rejected');

    const noInitialProject = await createProject('no-initial');
    await generateInitial(noInitialProject, adminId, 'none');
    check((await schedule(noInitialProject, adminId, futureA)).resultCode === 'INITIAL_NOTIFICATION_REQUIRED', 'Initial notification is required');
    const failedProject = await createProject('initial-failed');
    await generateInitial(failedProject, adminId, 'failed');
    check((await schedule(failedProject, adminId, futureA)).resultCode === 'INITIAL_DELIVERY_NOT_CONFIRMED', 'Failed initial delivery blocks scheduling');
    const unknownProject = await createProject('initial-unknown');
    await generateInitial(unknownProject, adminId, 'unknown');
    check((await schedule(unknownProject, adminId, futureA)).resultCode === 'INITIAL_DELIVERY_NOT_CONFIRMED', 'Unknown initial delivery blocks scheduling');

    // Future work is left untouched; cancellation is durable and idempotent.
    const futureRun = await runParticipantPreviewReminders({
      enabled: true, notifications: repository, transport: smtp, fromAddress: SMTP.from,
    });
    check(futureRun.claimed === 0, 'Future-not-due reminders send zero mail');
    const cancelled = await repository.cancel({
      publicId: primary.public_id, adminId, reference: reviewerSchedule.reference ?? '',
    });
    check(cancelled.resultCode === 'CANCELLED', 'Authorized staff can cancel a future reminder');
    check((await repository.cancel({ publicId: primary.public_id, adminId, reference: reviewerSchedule.reference ?? '' })).resultCode === 'ALREADY_CANCELLED', 'Cancellation is idempotent');
    await repository.cancel({ publicId: primary.public_id, adminId, reference: adminSchedule.reference ?? '' });
    await repository.cancel({ publicId: primary.public_id, adminId, reference: concurrentSchedules[0].reference ?? '' });

    // Build one actual due delivery and five due suppressions, then process one bounded batch.
    const dueAt = new Date(Date.now() + 10_000);
    const dueProject = await createProject('due');
    const dueInitial = await generateInitial(dueProject);
    const dueSchedule = await schedule(dueProject, adminId, dueAt);

    const confirmedProject = await createProject('confirmed');
    const confirmedInitial = await generateInitial(confirmedProject);
    const confirmedSchedule = await schedule(confirmedProject, adminId, dueAt);
    await adminClient.rpc('confirm_participant_preview', { p_token_hash: hash(confirmedInitial.rawToken) });

    const correctionProject = await createProject('correction');
    const correctionInitial = await generateInitial(correctionProject);
    const correctionSchedule = await schedule(correctionProject, adminId, dueAt);
    await adminClient.rpc('request_participant_preview_correction', {
      p_token_hash: hash(correctionInitial.rawToken), p_comment: 'Synthetic correction request.',
    });

    const revokedProject = await createProject('revoked');
    await generateInitial(revokedProject);
    const revokedSchedule = await schedule(revokedProject, adminId, dueAt);
    await adminClient.rpc('revoke_participant_preview', {
      p_public_id: revokedProject.public_id, p_admin_id: adminId,
    });

    const expiredProject = await createProject('expired');
    const expiredInitial = await generateInitial(expiredProject);
    const expiredSchedule = await schedule(expiredProject, adminId, dueAt);
    await adminClient.from('participant_previews').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', expiredInitial.previewId);

    const changedProject = await createProject('changed');
    await generateInitial(changedProject);
    const changedSchedule = await schedule(changedProject, adminId, dueAt);
    await adminClient.from('projects').update({ participant_contact_email: address('changed-new') }).eq('id', changedProject.id);

    const supersededProject = await createProject('superseded');
    await generateInitial(supersededProject);
    const supersededSchedule = await schedule(supersededProject, adminId, dueAt);
    await adminClient.rpc('revoke_participant_preview', { p_public_id: supersededProject.public_id, p_admin_id: adminId });
    const previewB = await generateInitial(supersededProject);
    const previewBSchedule = await schedule(supersededProject, adminId, new Date(Date.now() + 90_000));
    check(previewBSchedule.resultCode === 'SCHEDULED', 'Preview B has an independent reminder lifecycle');

    await delay(Math.max(0, dueAt.getTime() - Date.now() + 250));
    const dueResult = await runParticipantPreviewReminders({
      enabled: true, notifications: repository, transport: smtp, fromAddress: SMTP.from,
    });
    check(dueResult.sent === 1, 'One eligible due reminder reaches the Local SMTP sink');
    check(dueResult.skipped === 6, 'Ineligible due reminders are skipped before transport');
    const dueRow = await scheduleRow(dueSchedule.reference ?? '');
    const dueNotification = await reminderNotification(String(dueRow?.id ?? ''));
    check(dueRow?.status === 'triggered', 'Eligible schedule transitions to triggered');
    check(dueNotification?.notification_kind === 'reminder', 'Triggered notification kind is reminder');
    check(dueNotification?.reminder_schedule_id === dueRow?.id, 'Reminder notification links the exact schedule');
    check(dueNotification?.participant_preview_id === dueInitial.previewId, 'Reminder notification retains exact-preview binding');
    check(dueNotification?.status === 'sent', 'Reminder delivery ledger reaches sent');
    const dueMail = await mailbox(String(dueProject.participant_contact_email));
    check(dueMail.length === 2, 'Recipient mailbox has one initial email and one reminder email');
    const reminderMessage = dueMail.find((message) => message.Subject.startsWith('Reminder:'));
    const reminderBody = reminderMessage ? await mailBody(reminderMessage.ID) : '';
    check(Boolean(reminderMessage), 'Received message has the dedicated reminder subject');
    check(reminderBody.includes(String(dueProject.title)), 'Received reminder contains the project title');
    check(reminderBody.includes('original review email'), 'Received reminder directs the participant to the original email');
    check(!reminderBody.match(/https?:\/\//i), 'Received reminder contains no URL');
    check(!reminderBody.includes('/participant-preview/'), 'Received reminder contains no participant-preview path');
    check((await scheduleRow(confirmedSchedule.reference ?? ''))?.skip_reason === 'PREVIEW_CONFIRMED', 'Confirmation suppresses a due reminder');
    check((await scheduleRow(correctionSchedule.reference ?? ''))?.skip_reason === 'CORRECTION_PENDING', 'Open correction suppresses a due reminder');
    check((await scheduleRow(revokedSchedule.reference ?? ''))?.skip_reason === 'PREVIEW_REVOKED', 'Revocation suppresses a due reminder');
    check((await scheduleRow(expiredSchedule.reference ?? ''))?.skip_reason === 'PREVIEW_EXPIRED', 'Expiry suppresses a due reminder');
    check((await scheduleRow(changedSchedule.reference ?? ''))?.skip_reason === 'CONTACT_CHANGED', 'Contact change suppresses both old and new destinations');
    check((await scheduleRow(supersededSchedule.reference ?? ''))?.skip_reason === 'PREVIEW_SUPERSEDED', 'Preview B suppresses Preview A reminder');
    check((await mailbox(address('changed'))).length === 1 && (await mailbox(address('changed-new'))).length === 0, 'Contact-change skip sends no reminder to either address');

    const secondRun = await runParticipantPreviewReminders({
      enabled: true, notifications: repository, transport: smtp, fromAddress: SMTP.from,
    });
    check(secondRun.claimed === 0, 'A second runner execution sends no duplicate reminder');

    // Deterministic lease-lifetime barrier: later due work remains a schedule until the earlier
    // reminder has crossed its transport attempt, so its short execution lease cannot burn in memory.
    const incrementalProjectA = await createProject('incremental-a');
    const incrementalProjectB = await createProject('incremental-b');
    await generateInitial(incrementalProjectA);
    await generateInitial(incrementalProjectB);
    const incrementalAtA = new Date(Date.now() + 2_000);
    const incrementalAtB = new Date(incrementalAtA.getTime() + 500);
    const incrementalScheduleA = await schedule(incrementalProjectA, adminId, incrementalAtA);
    const incrementalScheduleB = await schedule(incrementalProjectB, adminId, incrementalAtB);
    const incrementalRowABefore = await scheduleRow(incrementalScheduleA.reference ?? '');
    const incrementalRowBBefore = await scheduleRow(incrementalScheduleB.reference ?? '');
    await delay(Math.max(0, incrementalAtB.getTime() - Date.now() + 150));
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const gated = {
      claimDue: repository.claimDue.bind(repository),
      getStaleReminderNotificationIds: repository.getStaleReminderNotificationIds.bind(repository),
      reconcile: repository.reconcile.bind(repository),
      finalize: repository.finalize.bind(repository),
      beginTransport: async (notificationId: string, executionToken: string) => {
        entered();
        await releasePromise;
        return repository.beginTransport(notificationId, executionToken);
      },
    };
    const firstRunner = runParticipantPreviewReminders({
      enabled: true, notifications: gated, transport: smtp, fromAddress: SMTP.from, batchLimit: 2,
    });
    await enteredPromise;
    const incrementalRowAPaused = await scheduleRow(incrementalScheduleA.reference ?? '');
    const incrementalRowBPaused = await scheduleRow(incrementalScheduleB.reference ?? '');
    const incrementalNotificationAPaused = await reminderNotification(String(incrementalRowABefore?.id ?? ''));
    const incrementalNotificationBPaused = await reminderNotification(String(incrementalRowBBefore?.id ?? ''));
    check(
      incrementalRowAPaused?.status === 'triggered' &&
      incrementalNotificationAPaused?.status === 'reserved',
      'Runner creates the first execution lease immediately before its transport attempt',
    );
    check(
      incrementalRowBPaused?.status === 'scheduled' && incrementalNotificationBPaused === null,
      'Later due reminder remains scheduled with no execution lease while the first transport is paused',
    );
    release();
    const firstRunnerResult = await firstRunner;
    const incrementalNotificationA = await reminderNotification(String(incrementalRowABefore?.id ?? ''));
    const incrementalNotificationB = await reminderNotification(String(incrementalRowBBefore?.id ?? ''));
    check(firstRunnerResult.claimed === 2 && firstRunnerResult.sent === 2, 'Runner claims and sends the later reminder only after the first completes');
    check(
      incrementalNotificationA?.status === 'sent' && incrementalNotificationB?.status === 'sent',
      'Each incrementally claimed schedule has one linked sent notification',
    );
    check(
      (await mailbox(String(incrementalProjectA.participant_contact_email))).length === 2 &&
      (await mailbox(String(incrementalProjectB.participant_contact_email))).length === 2,
      'Each incremental schedule produces exactly one reminder transport',
    );

    // Ambiguous and known failure outcomes are terminal; neither schedule retries automatically.
    const ambiguousProject = await createProject('ambiguous');
    await generateInitial(ambiguousProject);
    const ambiguousAt = new Date(Date.now() + 2_000);
    await schedule(ambiguousProject, adminId, ambiguousAt);
    await delay(Math.max(0, ambiguousAt.getTime() - Date.now() + 150));
    let ambiguousCalls = 0;
    const ambiguousTransport = { send: async () => { ambiguousCalls += 1; return { outcome: 'unknown' as const }; } };
    const ambiguousResult = await runParticipantPreviewReminders({
      enabled: true, notifications: repository, transport: ambiguousTransport, fromAddress: SMTP.from,
    });
    await runParticipantPreviewReminders({
      enabled: true, notifications: repository, transport: ambiguousTransport, fromAddress: SMTP.from,
    });
    check(ambiguousResult.deliveryUnknown === 1 && ambiguousCalls === 1, 'Ambiguous delivery is terminal and never automatically retried');

    const failedDeliveryProject = await createProject('known-failure');
    await generateInitial(failedDeliveryProject);
    const failedDeliveryAt = new Date(Date.now() + 2_000);
    await schedule(failedDeliveryProject, adminId, failedDeliveryAt);
    await delay(Math.max(0, failedDeliveryAt.getTime() - Date.now() + 150));
    let failedCalls = 0;
    const rejectedTransport = { send: async () => { failedCalls += 1; return { outcome: 'rejected' as const, failureCode: 'MESSAGE_REJECTED' as const }; } };
    const failedResult = await runParticipantPreviewReminders({
      enabled: true, notifications: repository, transport: rejectedTransport, fromAddress: SMTP.from,
    });
    check(failedResult.failed === 1 && failedCalls === 1, 'Known transport rejection is terminal without retry');

    const disabledProject = await createProject('disabled');
    await generateInitial(disabledProject);
    const disabledAt = new Date(Date.now() + 2_000);
    const disabledSchedule = await schedule(disabledProject, adminId, disabledAt);
    await delay(Math.max(0, disabledAt.getTime() - Date.now() + 150));
    const disabledResult = await runParticipantPreviewReminders({
      enabled: false, notifications: repository, transport: smtp, fromAddress: SMTP.from,
    });
    check(disabledResult.code === 'DISABLED' && (await scheduleRow(disabledSchedule.reference ?? ''))?.status === 'scheduled', 'Disabled runner claims nothing and leaves work scheduled');

    // Data API denial and trusted service-role evidence.
    const anonInsert = await anon.from('participant_preview_reminder_schedules').insert({});
    const anonClaim = await anon.rpc('claim_due_participant_preview_reminders', { p_batch_limit: 1 });
    check(Boolean(anonInsert.error) && Boolean(anonClaim.error), 'Anon cannot mutate schedules or invoke the trusted runner RPC');
    const browserEmail = address('browser');
    const password = `Local-${crypto.randomBytes(16).toString('hex')}!`;
    const created = await adminClient.auth.admin.createUser({ email: browserEmail, password, email_confirm: true });
    if (created.data.user) authUsers.push(created.data.user.id);
    const browser = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    await browser.auth.signInWithPassword({ email: browserEmail, password });
    const browserInsert = await browser.from('participant_preview_reminder_schedules').insert({});
    const browserClaim = await browser.rpc('claim_due_participant_preview_reminders', { p_batch_limit: 1 });
    check(Boolean(browserInsert.error) && Boolean(browserClaim.error), 'Ordinary authenticated browser role cannot mutate or claim reminders');
    await browser.auth.signOut();
    check(Boolean(dueRow && dueNotification), 'Trusted service-role schedule and notification path works');

    const serializedSchedule = JSON.stringify(dueRow);
    const serializedNotification = JSON.stringify(dueNotification);
    check(!serializedSchedule.includes(dueInitial.rawToken) && !serializedSchedule.includes('/participant-preview/'), 'Schedule row stores no preview credential or URL');
    check(!serializedNotification.includes(dueInitial.rawToken) && !serializedNotification.includes('/participant-preview/'), 'Reminder notification row stores no preview credential or URL');
    const { data: dueProjectAfter } = await adminClient.from('projects').select('status').eq('id', dueProject.id).single();
    const { count: dueResponses } = await adminClient.from('participant_preview_confirmations').select('id', { count: 'exact', head: true }).eq('participant_preview_id', dueInitial.previewId);
    check(dueProjectAfter?.status === 'approved' && dueResponses === 0, 'Reminder delivery does not mutate project or participant response state');
    check(previewB.previewId !== primaryInitial.previewId, 'Independent preview histories remain distinct');
  } catch (error: unknown) {
    success = false;
    console.error('FAIL: Unexpected reminder runtime error.', error instanceof Error ? error.message : 'UNKNOWN');
  } finally {
    let clean = true;
    try {
      if (client) {
        const { error } = await client.from('projects').delete().like('public_id', `${prefix}-%`);
        if (error) clean = false;
        for (const id of authUsers) {
          if ((await client.auth.admin.deleteUser(id)).error) clean = false;
        }
        const { count: projectCount } = await client.from('projects')
          .select('id', { count: 'exact', head: true }).like('public_id', `${prefix}-%`);
        const { count: scheduleCount } = await client.from('participant_preview_reminder_schedules')
          .select('id', { count: 'exact', head: true }).like('recipient_email_snapshot', `${prefix}-%`);
        check(clean && projectCount === 0 && scheduleCount === 0, 'Verifier cleanup restores its owned database baseline');
      }
    } catch {
      check(false, 'Verifier cleanup restores its owned database baseline');
    }
  }

  console.log(`\nScenarios executed: ${scenarios}`);
  console.log(success ? 'OVERALL RUNTIME VERIFICATION RESULT: PASS' : 'OVERALL RUNTIME VERIFICATION RESULT: FAIL');
  return success;
}

if (require.main === module) {
  runParticipantPreviewReminderRuntimeVerification()
    .then((passed) => { if (!passed) process.exitCode = 1; })
    .catch(() => { process.exitCode = 1; });
}
