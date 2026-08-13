import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { SupabaseParticipantPreviewNotificationRepositoryCore } from '../repositories/SupabaseParticipantPreviewNotificationRepositoryCore';
import { ParticipantPreviewExecutionError } from '../repositories/ParticipantPreviewRepository';
import { SmtpParticipantPreviewEmailTransport } from '../notifications/smtpParticipantPreviewEmailTransport';
import { executeParticipantPreviewNotification } from '../notifications/participantPreviewNotificationService';
import type { ParticipantPreviewEmailSmtpConfig } from '../notifications/participantPreviewEmailConfig';

/**
 * Local/disposable runtime verification for participant preview email notification.
 *
 * Runs the real production code path — the same repository, the same orchestration service and the
 * same SMTP transport the Admin route uses — against Local Supabase and the Local email sink that
 * the pinned stack already ships. No external mail provider, relay or real mailbox is contacted at
 * any point, and every recipient address belongs to this run's unique prefix.
 *
 * Output discipline: this verifier parses received messages internally in order to prove that the
 * exact freshly generated secure link arrived, but it prints only bounded facts — scenario name,
 * pass/fail, notification state. The raw preview credential is never printed, and neither is any
 * message body.
 */

const PRIVATE_DRAFT_BUCKET = 'project-drafts-private';
/** The pinned Local stack's email sink. Its inspection API belongs to verification only. */
const LOCAL_MAIL_API = 'http://127.0.0.1:54324/api/v1';
const LOCAL_SMTP: ParticipantPreviewEmailSmtpConfig = {
  host: '127.0.0.1',
  port: 54325,
  secure: false,
  auth: null,
  from: 'no-reply@capstone.invalid',
};

export interface NotificationRuntimeVerificationOptions {
  repoRoot?: string;
}

interface MailMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

function newRawToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export async function runParticipantPreviewNotificationRuntimeVerification(
  options?: NotificationRuntimeVerificationOptions,
): Promise<boolean> {
  console.log('=== Local Supabase Participant Preview Email Notification Runtime Verification ===\n');
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../..');

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testPrefix = `ppn-${runId}`;
  const recipientFor = (suffix: string) => `${testPrefix}-${suffix}@capstone.invalid`;

  let success = true;
  let adminClient: SupabaseClient | null = null;
  const createdAuthUserIds: string[] = [];
  let scenarios = 0;

  const pass = (name: string, detail?: string) => {
    scenarios += 1;
    console.log(`PASS: ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const fail = (name: string, detail?: string) => {
    scenarios += 1;
    success = false;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const check = (condition: boolean, name: string, detail?: string) => {
    if (condition) pass(name, detail);
    else fail(name, detail);
  };

  try {
    const workdir = path.resolve(repoRoot, 'infra');
    const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
    const rawEnv = execSync(`"${cliPath}" status --workdir "${workdir}" -o env`, {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    const parsedEnv = parseSupabaseCliEnv(rawEnv);

    const apiUrl = parsedEnv.API_URL || 'http://127.0.0.1:54321';
    const serviceKey = parsedEnv.SERVICE_ROLE_KEY || '';
    const anonKey = parsedEnv.ANON_KEY || '';

    adminClient = createClient(apiUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const client = adminClient;
    const anonClient = createClient(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const repository = new SupabaseParticipantPreviewNotificationRepositoryCore(client);
    const transport = new SmtpParticipantPreviewEmailTransport(LOCAL_SMTP);

    const { data: rolesData, error: rolesError } = await client.from('user_roles').select('user_id, role');
    if (rolesError || !rolesData) {
      console.error('FAIL: Failed to resolve local user_roles.');
      return false;
    }
    const adminId = String(rolesData.find((r) => r.role === 'admin')?.user_id ?? '');
    const reviewerId = String(rolesData.find((r) => r.role === 'reviewer')?.user_id ?? '');
    const editorId = String(rolesData.find((r) => r.role === 'editor')?.user_id ?? '');
    if (!adminId || !reviewerId || !editorId) {
      console.error('FAIL: Failed to resolve local staff users.');
      return false;
    }

    // --- fixtures -------------------------------------------------------------------------------

    const createProject = async (suffix: string, contactEmail: string | null, status = 'approved') => {
      const publicId = `${testPrefix}-${suffix}`;
      const { data, error } = await client
        .from('projects')
        .insert({
          public_id: publicId,
          title: `Runtime Notification Test ${suffix}`,
          summary: 'Synthetic summary for runtime verification.',
          year: 2026,
          status,
          participant_contact_email: contactEmail,
          // Approval requires accessible poster content. This verifier exercises email delivery
          // lifecycle, so its fixture is compliant by construction.
          poster_text_public: 'Synthetic runtime poster full text.',
          accessibility_text_public: 'Synthetic runtime accessibility text.',
        })
        .select()
        .single();
      if (error || !data) throw new Error(`Failed to create project fixture ${publicId}: ${error?.message}`);
      return data as Record<string, unknown>;
    };

    const generateAndReserve = async (publicId: string, actorId: string, isCorrectionReissue = false) => {
      const raw = newRawToken();
      const { data, error } = await client.rpc('generate_participant_preview_with_notification', {
        p_public_id: publicId,
        p_admin_id: actorId,
        p_token_hash: hashToken(raw),
        p_expires_in_seconds: null,
        p_private_bucket: PRIVATE_DRAFT_BUCKET,
        p_is_correction_reissue: isCorrectionReissue,
      });
      return { raw, data: (data ?? null) as Record<string, unknown> | null, error };
    };

    const notificationRow = async (previewId: string) => {
      const { data } = await client
        .from('participant_preview_notifications')
        .select('*')
        .eq('participant_preview_id', previewId)
        .maybeSingle();
      return (data ?? null) as Record<string, unknown> | null;
    };

    /** Reads the Local email sink. Every address carries the run prefix, so the search is exact. */
    const mailbox = async (address: string): Promise<MailMessage[]> => {
      const response = await fetch(`${LOCAL_MAIL_API}/search?query=${encodeURIComponent(`to:${address}`)}`);
      if (!response.ok) throw new Error('Local email sink is not reachable.');
      const payload = (await response.json()) as { messages?: MailMessage[] };
      return payload.messages ?? [];
    };

    const mailBody = async (id: string): Promise<string> => {
      const response = await fetch(`${LOCAL_MAIL_API}/message/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error('Local message could not be read.');
      const message = (await response.json()) as { HTML?: string; Text?: string };
      return `${message.HTML ?? ''}\n${message.Text ?? ''}`;
    };

    /**
     * The whole production path in one call: the atomic generate + reserve transaction, then the
     * fenced transport-started boundary, the real SMTP send and the bounded finalization — using the
     * exact repository, orchestration service and transport the Admin route uses.
     */
    const sendFor = async (publicId: string, actorId: string, isCorrectionReissue = false) => {
      const raw = newRawToken();
      let generated: Awaited<ReturnType<typeof repository.generatePreviewWithNotification>>;
      try {
        generated = await repository.generatePreviewWithNotification({
          publicId,
          adminId: actorId,
          tokenHash: hashToken(raw),
          privateBucket: PRIVATE_DRAFT_BUCKET,
          isCorrectionReissue,
        });
      } catch (error: unknown) {
        // Ordinary preview-lifecycle refusals (an active preview already exists, an unresolved
        // correction, and so on) surface as the existing ParticipantPreviewExecutionError. They are
        // legitimate outcomes here, not verifier failures.
        const code = error instanceof ParticipantPreviewExecutionError ? error.code : 'INTERNAL_FAILURE';
        return { generated: { resultCode: code } as const, raw, previewUrl: undefined, outcome: null };
      }

      if (generated.resultCode !== 'SUCCESS') {
        return { generated, raw, previewUrl: undefined, outcome: null };
      }

      const previewUrl = `http://localhost:3000/participant-preview/${raw}`;
      const outcome = await executeParticipantPreviewNotification(
        { notifications: repository, transport },
        {
          notificationId: generated.value.notificationId,
          executionToken: generated.value.executionToken,
          recipient: generated.value.recipient,
          projectTitle: generated.value.projectTitle,
          previewUrl,
          expiresAt: generated.value.expiresAt,
          fromAddress: LOCAL_SMTP.from,
        },
      );
      return { generated, raw, previewUrl, outcome };
    };

    // ============================================================================================
    console.log('--- Authorization and authoritative recipient resolution ---');
    // ============================================================================================

    const t1Recipient = recipientFor('t1');
    const t1Project = await createProject('t1', t1Recipient);
    const t1 = await generateAndReserve(String(t1Project.public_id), adminId);
    check(t1.data?.resultCode === 'SUCCESS', 'Admin may initiate Generate + Send');
    check(
      t1.data?.recipient === t1Recipient,
      'Recipient snapshot equals the authoritative persisted contact',
      String(t1.data?.recipient ?? 'none'),
    );

    const t2Project = await createProject('t2', recipientFor('t2'));
    const t2 = await generateAndReserve(String(t2Project.public_id), reviewerId);
    check(
      t2.data?.resultCode === 'SUCCESS',
      'Reviewer may initiate, matching participant preview management authority',
    );

    const t3Project = await createProject('t3', recipientFor('t3'));
    const t3 = await generateAndReserve(String(t3Project.public_id), editorId);
    check(
      t3.data?.resultCode === 'PREVIEW_PERMISSION_DENIED',
      'Editor-only actor is denied, matching existing preview policy',
    );

    const t4 = await generateAndReserve(String(t3Project.public_id), crypto.randomUUID());
    check(
      t4.data?.resultCode === 'PREVIEW_PERMISSION_DENIED',
      'Unprovisioned actor identity is denied',
    );

    const { count: t5PreviewCount } = await client
      .from('participant_previews')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', t3Project.id);
    check(t5PreviewCount === 0, 'A denied Generate + Send creates no preview at all');

    const t6Project = await createProject('t6', null);
    const t6 = await generateAndReserve(String(t6Project.public_id), adminId);
    const { count: t6PreviewCount } = await client
      .from('participant_previews')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', t6Project.id);
    check(
      t6.data?.resultCode === 'PARTICIPANT_EMAIL_MISSING' && t6PreviewCount === 0,
      'Missing authoritative contact fails before transport and burns no preview credential',
    );

    const t7Project = await createProject('t7', null);
    await client.from('projects').update({ participant_contact_email: 'not-an-email' }).eq('id', t7Project.id);
    const t7 = await generateAndReserve(String(t7Project.public_id), adminId);
    const { count: t7PreviewCount } = await client
      .from('participant_previews')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', t7Project.id);
    check(
      t7.data?.resultCode === 'PARTICIPANT_EMAIL_INVALID' && t7PreviewCount === 0,
      'Invalid authoritative contact fails before transport and burns no preview credential',
    );

    // ============================================================================================
    console.log('\n--- Backward compatibility of ordinary Generate Without Email ---');
    // ============================================================================================

    const t8Recipient = recipientFor('t8');
    const t8Project = await createProject('t8', t8Recipient);
    const t8Raw = newRawToken();
    const { data: t8Gen } = await client.rpc('generate_participant_preview', {
      p_public_id: String(t8Project.public_id),
      p_admin_id: adminId,
      p_token_hash: hashToken(t8Raw),
      p_expires_in_seconds: null,
      p_private_bucket: PRIVATE_DRAFT_BUCKET,
      p_is_correction_reissue: false,
    });
    const t8Notification = await notificationRow(String((t8Gen as Record<string, unknown>)?.previewId ?? ''));
    const t8Mail = await mailbox(t8Recipient);
    check(
      (t8Gen as Record<string, unknown>)?.resultCode === 'SUCCESS' &&
        t8Notification === null &&
        t8Mail.length === 0,
      'Generate Without Email still works, creates no delivery lifecycle and sends zero mail',
    );

    // ============================================================================================
    console.log('\n--- Delivery through the Local email sink ---');
    // ============================================================================================

    const t9Recipient = recipientFor('t9');
    const t9Project = await createProject('t9', t9Recipient);
    const t9 = await sendFor(String(t9Project.public_id), adminId);

    check(t9.outcome?.code === 'SENT', 'Generate + Send reports a reliably accepted delivery', t9.outcome?.code);

    const t9PreviewId = t9.generated.resultCode === 'SUCCESS' ? t9.generated.value.previewId : '';
    const t9Row = await notificationRow(t9PreviewId);
    check(
      t9Row?.participant_preview_id === t9PreviewId && t9Row?.project_id === t9Project.id,
      'Delivery binds the exact participant preview id, not the project alone',
    );
    check(
      t9Row?.requested_by_admin_id === adminId,
      'Requesting actor attribution is the server-derived authenticated admin',
    );
    check(t9Row?.notification_kind === 'initial', 'Notification kind is the initial participant notification');
    check(t9Row?.status === 'sent', 'Ledger state machine reached sent', String(t9Row?.status));
    check(
      typeof t9Row?.transport_started_at === 'string' && typeof t9Row?.sent_at === 'string',
      'Both the transport boundary and the acceptance are durably timestamped',
    );

    const t9Mail = await mailbox(t9Recipient);
    check(t9Mail.length === 1, 'The Local email sink received exactly one message', `count=${t9Mail.length}`);
    check(
      t9Mail[0]?.To?.some((entry) => entry.Address.toLowerCase() === t9Recipient),
      'The message went to the authoritative recipient',
    );

    const t9Body = t9Mail.length === 1 ? await mailBody(t9Mail[0].ID) : '';
    check(
      t9.previewUrl !== undefined && t9Body.includes(t9.previewUrl),
      'The message carries the exact freshly generated secure preview link',
    );

    const { data: t9Resolved } = await client.rpc('resolve_participant_preview', {
      p_token_hash: hashToken(t9.raw),
    });
    check(
      (t9Resolved as Record<string, unknown>)?.resultCode === 'SUCCESS' &&
        (t9Resolved as Record<string, unknown>)?.previewId === t9PreviewId,
      'The emailed link resolves the exact preview it was generated for',
    );

    // ============================================================================================
    console.log('\n--- Credential non-persistence ---');
    // ============================================================================================

    const serializedRow = JSON.stringify(t9Row ?? {});
    check(!serializedRow.includes(t9.raw), 'The delivery row contains no raw preview token');
    check(
      t9.previewUrl !== undefined && !serializedRow.includes(t9.previewUrl),
      'The delivery row contains no secure preview URL',
    );
    check(
      !serializedRow.includes('http://') && !serializedRow.includes('https://'),
      'The delivery row contains no URL of any kind',
    );

    const { data: t9PreviewRow } = await client
      .from('participant_previews')
      .select('*')
      .eq('id', t9PreviewId)
      .maybeSingle();
    check(
      !JSON.stringify(t9PreviewRow ?? {}).includes(t9.raw),
      'The preview row still stores only the token hash',
    );

    const readModel = await repository.getNotificationForPreview(t9PreviewId);
    const serializedView = JSON.stringify(readModel ?? {});
    check(
      readModel?.status === 'sent' && readModel.recipient === t9Recipient,
      'The staff read model reports the authoritative delivery state',
    );
    check(
      !serializedView.includes('execution') &&
        !serializedView.includes('lease') &&
        !serializedView.includes(t9.raw),
      'The staff read model exposes no execution credential, lease or preview token',
    );

    // ============================================================================================
    console.log('\n--- Convergence of duplicate requests ---');
    // ============================================================================================

    const t10 = await sendFor(String(t9Project.public_id), adminId);
    const t10Mail = await mailbox(t9Recipient);
    check(
      t10.generated.resultCode !== 'SUCCESS' && t10Mail.length === 1,
      'A sequential duplicate Generate + Send produces no second message',
      `count=${t10Mail.length}`,
    );

    const t11Recipient = recipientFor('t11');
    const t11Project = await createProject('t11', t11Recipient);
    const [t11a, t11b] = await Promise.all([
      sendFor(String(t11Project.public_id), adminId),
      sendFor(String(t11Project.public_id), adminId),
    ]);
    const t11Mail = await mailbox(t11Recipient);
    const t11Successes = [t11a, t11b].filter((r) => r.generated.resultCode === 'SUCCESS').length;
    check(
      t11Successes === 1 && t11Mail.length === 1,
      'Concurrent duplicate Generate + Send results in exactly one preview and one message',
      `successes=${t11Successes} mail=${t11Mail.length}`,
    );

    const t12Reserve = await client.rpc('reserve_participant_preview_notification', {
      p_participant_preview_id: t9PreviewId,
      p_admin_id: adminId,
      p_notification_kind: 'initial',
    });
    const t12 = t12Reserve.data as Record<string, unknown> | null;
    check(
      t12?.resultCode === 'ALREADY_SENT' && t12?.executionToken === undefined,
      'Re-reserving a delivered lifecycle observes it and grants no execution token',
      String(t12?.resultCode),
    );

    // ============================================================================================
    console.log('\n--- Preview eligibility gates ---');
    // ============================================================================================

    const t13Recipient = recipientFor('t13');
    const t13Project = await createProject('t13', t13Recipient);
    const t13Raw = newRawToken();
    const { data: t13Gen } = await client.rpc('generate_participant_preview', {
      p_public_id: String(t13Project.public_id),
      p_admin_id: adminId,
      p_token_hash: hashToken(t13Raw),
      p_expires_in_seconds: null,
      p_private_bucket: PRIVATE_DRAFT_BUCKET,
      p_is_correction_reissue: false,
    });
    const t13PreviewId = String((t13Gen as Record<string, unknown>)?.previewId ?? '');
    await client.rpc('revoke_participant_preview', {
      p_public_id: String(t13Project.public_id),
      p_admin_id: adminId,
    });
    const t13Reserve = await client.rpc('reserve_participant_preview_notification', {
      p_participant_preview_id: t13PreviewId,
      p_admin_id: adminId,
      p_notification_kind: 'initial',
    });
    check(
      (t13Reserve.data as Record<string, unknown>)?.resultCode === 'PREVIEW_NOT_ELIGIBLE',
      'A revoked preview cannot be notified',
    );

    const t14Project = await createProject('t14', recipientFor('t14'));
    const t14Raw = newRawToken();
    const { data: t14Gen } = await client.rpc('generate_participant_preview', {
      p_public_id: String(t14Project.public_id),
      p_admin_id: adminId,
      p_token_hash: hashToken(t14Raw),
      p_expires_in_seconds: null,
      p_private_bucket: PRIVATE_DRAFT_BUCKET,
      p_is_correction_reissue: false,
    });
    const t14PreviewId = String((t14Gen as Record<string, unknown>)?.previewId ?? '');
    await client
      .from('participant_previews')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', t14PreviewId);
    const t14Reserve = await client.rpc('reserve_participant_preview_notification', {
      p_participant_preview_id: t14PreviewId,
      p_admin_id: adminId,
      p_notification_kind: 'initial',
    });
    check(
      (t14Reserve.data as Record<string, unknown>)?.resultCode === 'PREVIEW_NOT_ELIGIBLE',
      'An expired preview cannot be notified',
    );

    const t15Project = await createProject('t15', recipientFor('t15'));
    const t15Raw = newRawToken();
    const { data: t15Gen } = await client.rpc('generate_participant_preview', {
      p_public_id: String(t15Project.public_id),
      p_admin_id: adminId,
      p_token_hash: hashToken(t15Raw),
      p_expires_in_seconds: null,
      p_private_bucket: PRIVATE_DRAFT_BUCKET,
      p_is_correction_reissue: false,
    });
    const t15PreviewId = String((t15Gen as Record<string, unknown>)?.previewId ?? '');
    await client.rpc('confirm_participant_preview', { p_token_hash: hashToken(t15Raw) });
    const t15Reserve = await client.rpc('reserve_participant_preview_notification', {
      p_participant_preview_id: t15PreviewId,
      p_admin_id: adminId,
      p_notification_kind: 'initial',
    });
    check(
      (t15Reserve.data as Record<string, unknown>)?.resultCode === 'ALREADY_CONFIRMED',
      'A confirmed preview does not receive another initial notification',
    );

    // ============================================================================================
    console.log('\n--- Correction reissue: Preview A and Preview B are independent ---');
    // ============================================================================================

    const t16Recipient = recipientFor('t16');
    const t16Project = await createProject('t16', t16Recipient);
    const t16A = await sendFor(String(t16Project.public_id), adminId);
    const t16APreviewId = t16A.generated.resultCode === 'SUCCESS' ? t16A.generated.value.previewId : '';

    await client.rpc('request_participant_preview_correction', {
      p_token_hash: hashToken(t16A.raw),
      p_comment: 'Runtime verification correction request.',
    });
    await client.rpc('start_participant_preview_correction_resolution', {
      p_public_id: String(t16Project.public_id),
      p_admin_id: adminId,
    });
    await client.rpc('perform_project_review_action', {
      p_public_id: String(t16Project.public_id),
      p_action: 'approve',
      p_comments: 'Runtime verification re-approval.',
      p_admin_id: adminId,
    });
    const t16B = await sendFor(String(t16Project.public_id), adminId, true);
    const t16BPreviewId = t16B.generated.resultCode === 'SUCCESS' ? t16B.generated.value.previewId : '';

    check(
      t16B.outcome?.code === 'SENT' && t16BPreviewId !== '' && t16BPreviewId !== t16APreviewId,
      'Preview B receives its own independent delivery lifecycle',
    );

    const t16ARow = await notificationRow(t16APreviewId);
    check(
      t16ARow?.status === 'sent' && t16ARow?.participant_preview_id === t16APreviewId,
      "Preview A's delivery history is preserved unchanged",
    );

    const t16AReserve = await client.rpc('reserve_participant_preview_notification', {
      p_participant_preview_id: t16APreviewId,
      p_admin_id: adminId,
      p_notification_kind: 'initial',
    });
    check(
      ['ALREADY_SENT', 'PREVIEW_NOT_ELIGIBLE'].includes(
        String((t16AReserve.data as Record<string, unknown>)?.resultCode),
      ),
      'Superseded Preview A can never be notified again once Preview B is authoritative',
    );

    const t16Mail = await mailbox(t16Recipient);
    check(t16Mail.length === 2, 'Each preview produced exactly one message', `count=${t16Mail.length}`);

    // ============================================================================================
    console.log('\n--- Email notification never mutates surrounding workflow state ---');
    // ============================================================================================

    const { data: t17CorrectionRows } = await client
      .from('participant_preview_correction_requests')
      .select('status, resolved_at, replacement_preview_id')
      .eq('participant_preview_id', t16APreviewId);
    const t17Correction = (t17CorrectionRows ?? [])[0] as Record<string, unknown> | undefined;
    check(
      t17Correction?.status === 'resolved' && t17Correction?.replacement_preview_id === t16BPreviewId,
      'Correction resolution state is exactly what the correction workflow left, not what email did',
    );

    const { data: t18Confirmation } = await client
      .from('participant_preview_confirmations')
      .select('participant_preview_id')
      .eq('participant_preview_id', t16BPreviewId)
      .maybeSingle();
    check(t18Confirmation === null, 'Sending an email never confirms a preview on the participant\'s behalf');

    const { data: t19ProjectRow } = await client
      .from('projects')
      .select('status, pending_removal_from_public, public_removal_completed_at')
      .eq('id', t9Project.id)
      .maybeSingle();
    const t19 = t19ProjectRow as Record<string, unknown> | null;
    check(
      t19?.status === 'approved' &&
        t19?.pending_removal_from_public === false &&
        t19?.public_removal_completed_at === null,
      'Project workflow and publication state are untouched by email delivery',
    );

    const { count: t20MediaPromoted } = await client
      .from('media_assets')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', t9Project.id)
      .eq('is_public_approved', true);
    check(t20MediaPromoted === 0, 'No media was promoted to public visibility by email delivery');

    // ============================================================================================
    // ============================================================================================
    console.log('\n--- Interrupted executions settle truthfully and never resend ---');
    // ============================================================================================
    // The expired-lease reconciliation branch itself is deliberately NOT forced here. Faking an
    // expired lease would require UPDATE on the ledger, a privilege the production server does not
    // have and must not be granted for a test. That branch is proven deterministically by the
    // service-layer tests and by the migration contract test that pins its exact SQL. What runtime
    // proves is everything reachable through legitimate privileges: the pre-transport failure
    // transition, terminal immutability, an ambiguous post-transport outcome persisted end to end,
    // and the absence of any automatic resend.

    const t21Recipient = recipientFor('t21');
    const t21Project = await createProject('t21', t21Recipient);
    const t21Raw = newRawToken();
    const t21Generated = await repository.generatePreviewWithNotification({
      publicId: String(t21Project.public_id),
      adminId,
      tokenHash: hashToken(t21Raw),
      privateBucket: PRIVATE_DRAFT_BUCKET,
    });

    if (t21Generated.resultCode !== 'SUCCESS') {
      fail('Reserved a lifecycle for the interrupted-execution scenario');
    } else {
      const t21Live = await repository.reconcile(t21Generated.value.notificationId);
      check(
        t21Live.resultCode === 'IN_PROGRESS',
        'Reconciliation refuses to settle a lifecycle whose execution lease is still live',
        t21Live.resultCode,
      );

      // The orchestrator's own pre-transport failure path: durable evidence that transport never
      // began, recorded without any external side effect.
      const t21Settled = await repository.finalize(
        t21Generated.value.notificationId,
        t21Generated.value.executionToken,
        'failed',
        null,
        'TRANSPORT_NOT_STARTED',
      );
      const t21Row = await notificationRow(t21Generated.value.previewId);
      const t21Mail = await mailbox(t21Recipient);
      check(
        t21Settled.resultCode === 'FINALIZED' &&
          t21Row?.status === 'failed' &&
          t21Row?.failure_code === 'TRANSPORT_NOT_STARTED' &&
          t21Row?.transport_started_at === null &&
          t21Mail.length === 0,
        'A failure before transport settles as failed/TRANSPORT_NOT_STARTED with zero mail',
      );

      const t21Reopen = await repository.beginTransport(
        t21Generated.value.notificationId,
        t21Generated.value.executionToken,
      );
      const t21MailAfter = await mailbox(t21Recipient);
      check(
        ['EXECUTION_LEASE_EXPIRED', 'INVALID_STATE'].includes(t21Reopen.resultCode) &&
          t21MailAfter.length === 0,
        'The former owner cannot reopen a settled lifecycle or send anything',
        t21Reopen.resultCode,
      );

      const t21Terminal = await repository.reconcile(t21Generated.value.notificationId);
      check(
        t21Terminal.resultCode === 'NO_CHANGE' && t21Terminal.status === 'failed',
        'Reconciliation leaves an already-settled lifecycle exactly as it found it',
      );
    }

    const t22Recipient = recipientFor('t22');
    const t22Project = await createProject('t22', t22Recipient);
    const t22Raw = newRawToken();
    const t22Generated = await repository.generatePreviewWithNotification({
      publicId: String(t22Project.public_id),
      adminId,
      tokenHash: hashToken(t22Raw),
      privateBucket: PRIVATE_DRAFT_BUCKET,
    });

    if (t22Generated.resultCode !== 'SUCCESS') {
      fail('Reserved a lifecycle for the ambiguous-outcome scenario');
    } else {
      // Only the external boundary is substituted. The database, the fencing and the orchestration
      // are the real ones, so this proves delivery_unknown is persisted end to end.
      let ambiguousSends = 0;
      const ambiguousTransport = {
        async send() {
          ambiguousSends += 1;
          return { outcome: 'unknown' } as const;
        },
      };

      const t22Outcome = await executeParticipantPreviewNotification(
        { notifications: repository, transport: ambiguousTransport },
        {
          notificationId: t22Generated.value.notificationId,
          executionToken: t22Generated.value.executionToken,
          recipient: t22Generated.value.recipient,
          projectTitle: t22Generated.value.projectTitle,
          previewUrl: `http://localhost:3000/participant-preview/${t22Raw}`,
          expiresAt: t22Generated.value.expiresAt,
          fromAddress: LOCAL_SMTP.from,
        },
      );

      const t22Row = await notificationRow(t22Generated.value.previewId);
      check(
        t22Outcome.code === 'DELIVERY_UNKNOWN' &&
          t22Row?.status === 'delivery_unknown' &&
          typeof t22Row?.transport_started_at === 'string' &&
          t22Row?.sent_at === null,
        'An ambiguous transport outcome is persisted as delivery_unknown, never as sent or failed',
        String(t22Row?.status),
      );
      check(ambiguousSends === 1, 'The external boundary was crossed exactly once');

      const t22Reserve = await client.rpc('reserve_participant_preview_notification', {
        p_participant_preview_id: t22Generated.value.previewId,
        p_admin_id: adminId,
        p_notification_kind: 'initial',
      });
      check(
        (t22Reserve.data as Record<string, unknown>)?.resultCode === 'DELIVERY_UNKNOWN' &&
          (t22Reserve.data as Record<string, unknown>)?.executionToken === undefined &&
          ambiguousSends === 1,
        'An ambiguous lifecycle is never automatically retried and grants no new execution',
      );

      const t22View = await repository.getNotificationForPreview(t22Generated.value.previewId);
      check(
        t22View?.status === 'delivery_unknown',
        'Staff see the ambiguous state truthfully rather than a perpetual "Sending"',
      );

      const t22Mail = await mailbox(t22Recipient);
      check(t22Mail.length === 0, 'The substituted boundary sent no real Local mail', `count=${t22Mail.length}`);
    }

    // ============================================================================================
    console.log('\n--- Database privilege boundary ---');
    // ============================================================================================

    const t23Select = await anonClient.from('participant_preview_notifications').select('id').limit(1);
    const t23Insert = await anonClient
      .from('participant_preview_notifications')
      .insert({ participant_preview_id: t9PreviewId });
    check(
      Boolean(t23Select.error) && Boolean(t23Insert.error),
      'anon can neither read nor write the delivery ledger directly',
    );

    const t24Reserve = await anonClient.rpc('reserve_participant_preview_notification', {
      p_participant_preview_id: t9PreviewId,
      p_admin_id: adminId,
      p_notification_kind: 'initial',
    });
    const t24Generate = await anonClient.rpc('generate_participant_preview_with_notification', {
      p_public_id: String(t9Project.public_id),
      p_admin_id: adminId,
      p_token_hash: hashToken(newRawToken()),
      p_expires_in_seconds: null,
      p_private_bucket: PRIVATE_DRAFT_BUCKET,
      p_is_correction_reissue: false,
    });
    const t24Finalize = await anonClient.rpc('finalize_participant_preview_notification', {
      p_notification_id: String(t9Row?.id ?? ''),
      p_execution_token: crypto.randomUUID(),
      p_outcome: 'sent',
      p_transport_reference: null,
      p_failure_code: null,
    });
    check(
      Boolean(t24Reserve.error) && Boolean(t24Generate.error) && Boolean(t24Finalize.error),
      'anon cannot execute any privileged notification RPC',
    );

    // A genuine authenticated browser session, created and owned by this run.
    const browserEmail = `${testPrefix}-browser@capstone.invalid`;
    const browserPassword = `Ppn-${crypto.randomBytes(18).toString('base64url')}`;
    const { data: browserUser } = await client.auth.admin.createUser({
      email: browserEmail,
      password: browserPassword,
      email_confirm: true,
    });
    if (browserUser?.user?.id) createdAuthUserIds.push(browserUser.user.id);

    const browserClient = createClient(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signedIn = await browserClient.auth.signInWithPassword({
      email: browserEmail,
      password: browserPassword,
    });

    if (signedIn.error || !signedIn.data.session) {
      fail('Established an authenticated browser session for the privilege check');
    } else {
      const t25Select = await browserClient.from('participant_preview_notifications').select('id').limit(1);
      const t25Reserve = await browserClient.rpc('reserve_participant_preview_notification', {
        p_participant_preview_id: t9PreviewId,
        p_admin_id: adminId,
        p_notification_kind: 'initial',
      });
      const t25Finalize = await browserClient.rpc('finalize_participant_preview_notification', {
        p_notification_id: String(t9Row?.id ?? ''),
        p_execution_token: crypto.randomUUID(),
        p_outcome: 'sent',
        p_transport_reference: null,
        p_failure_code: null,
      });
      const t25Reconcile = await browserClient.rpc('reconcile_participant_preview_notification', {
        p_notification_id: String(t9Row?.id ?? ''),
      });
      check(
        (t25Select.error !== null || (t25Select.data ?? []).length === 0) &&
          Boolean(t25Reserve.error) &&
          Boolean(t25Finalize.error) &&
          Boolean(t25Reconcile.error),
        'An ordinary authenticated browser role cannot read or drive the delivery lifecycle',
      );
      await browserClient.auth.signOut();
    }

    check(
      t9Row?.status === 'sent',
      'The trusted service-role server path is the only one that works, and it does',
    );

    // ============================================================================================
    console.log('\n--- Historical recipient snapshots are never rewritten ---');
    // ============================================================================================

    await client
      .from('projects')
      .update({ participant_contact_email: recipientFor('t9-changed') })
      .eq('id', t9Project.id);
    const t26Row = await notificationRow(t9PreviewId);
    check(
      t26Row?.recipient_email_snapshot === t9Recipient,
      'Changing the project contact never rewrites a historical delivery destination',
    );
  } catch (err: unknown) {
    console.error(
      'FAIL: Unexpected runtime verification error.',
      err instanceof Error ? err.message : 'UNKNOWN_FAILURE',
    );
    success = false;
  } finally {
    // Cleanup is scoped strictly to this run's own fixtures. Local email captured by the developer's
    // own stack is never deleted, and no message belonging to another run is touched.
    let cleanupError = false;
    try {
      if (adminClient) {
        const client = adminClient;
        const { data: testProjects } = await client
          .from('projects')
          .select('id')
          .like('public_id', `${testPrefix}-%`);
        const projectIds = (testProjects || []).map((p) => p.id);
        if (projectIds.length > 0) {
          // participant_preview_notifications cascades from both projects and previews.
          const previewDelete = await client.from('participant_previews').delete().in('project_id', projectIds);
          if (previewDelete.error) cleanupError = true;
        }
        const projectDelete = await client.from('projects').delete().like('public_id', `${testPrefix}-%`);
        if (projectDelete.error) cleanupError = true;

        for (const authUserId of createdAuthUserIds) {
          const removal = await client.auth.admin.deleteUser(authUserId);
          if (removal.error) cleanupError = true;
        }
      }
    } catch {
      cleanupError = true;
    }

    try {
      if (!adminClient) throw new Error('adminClient unavailable for post-cleanup verification');
      const client = adminClient;
      const { count: projectCount } = await client
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .like('public_id', `${testPrefix}-%`);
      const { count: notificationCount } = await client
        .from('participant_preview_notifications')
        .select('id', { count: 'exact', head: true })
        .like('recipient_email_snapshot', `${testPrefix}-%`);

      if (!cleanupError && projectCount === 0 && notificationCount === 0) {
        pass('Verifier cleanup restored the verifier-owned residue baseline');
      } else {
        fail(
          'Verifier cleanup restored the verifier-owned residue baseline',
          `projects=${projectCount} notifications=${notificationCount}`,
        );
      }
    } catch {
      fail('Independent post-cleanup verification executed');
    }
  }

  console.log('\n====================================================');
  console.log(`Scenarios executed: ${scenarios}`);
  console.log(success ? 'OVERALL RUNTIME VERIFICATION RESULT: PASS' : 'OVERALL RUNTIME VERIFICATION RESULT: FAIL');
  console.log('====================================================\n');

  return success;
}

if (require.main === module) {
  runParticipantPreviewNotificationRuntimeVerification()
    .then((passed) => {
      if (!passed) process.exit(1);
    })
    .catch(() => {
      process.exit(1);
    });
}
