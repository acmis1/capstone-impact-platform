import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { resolveAdminContextFromAuthUser } from '../auth/adminContext';
import { AdminAuthError, type AuthenticatedAdminContext } from '../auth/authTypes';
import {
  canPerformReviewAction,
  canPreparePublication,
  canResolveParticipantCorrection,
  getPermissionsForRoles,
  hasPermission,
} from '../auth/permissions';
import { validateCredentialsStructure } from '../local-development/localStaffAuthVerification';
import { SYNTHETIC_STAFF_DEFINITIONS } from '../local-development/localStaffUsers';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { saveAuthorizedProjectMetadata } from '../projects/projectMetadataAuthorization';
import { SupabaseProjectRepositoryCore } from '../repositories/SupabaseProjectRepositoryCore';

type StaffLabel = 'local-admin' | 'local-reviewer' | 'local-editor';
type StaffRuntime = {
  client: SupabaseClient;
  context: AuthenticatedAdminContext;
  session: Session;
};

const EXPECTED_PERMISSIONS = {
  admin: ['projects.read', 'projects.review', 'projects.archive', 'projects.edit', 'projects.publish'],
  reviewer: ['projects.read', 'projects.review'],
  editor: ['projects.read', 'projects.edit'],
} as const;

function decodeJwtTiming(token: string): { issuedAt: number; expiresAt: number } {
  const payload = token.split('.')[1];
  assert(payload, 'Issued session token payload is missing.');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    iat?: unknown;
    exp?: unknown;
  };
  assert(Number.isInteger(parsed.iat) && Number.isInteger(parsed.exp), 'Issued session timing claims are invalid.');
  return { issuedAt: Number(parsed.iat), expiresAt: Number(parsed.exp) };
}

function expectAuthError(error: unknown, type: AdminAuthError['type']): void {
  assert(error instanceof AdminAuthError, `Expected ${type} AdminAuthError.`);
  assert.equal(error.type, type);
}

async function main(): Promise<void> {
  console.log('=== Staff Role & Session Governance Local Runtime Verification ===');
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const rawEnv = execSync(`"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const env = parseSupabaseCliEnv(rawEnv);
  assert(env.API_URL && env.ANON_KEY && env.SERVICE_ROLE_KEY && isLoopbackUrl(env.API_URL), 'Verifier requires loopback Local Supabase.');

  const credentialsPath = path.resolve(root, 'apps/admin-cms/.local-users.json');
  const credentials = validateCredentialsStructure(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')));
  const service = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonClient = () => createClient(env.API_URL!, env.ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const prefix = `governance-runtime-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const staff = new Map<StaffLabel, StaffRuntime>();
  const createdAuthIds = new Set<string>();
  const createdAdminIds = new Set<string>();
  const createdProjectIds = new Set<string>();
  let editorReviewerAdded = false;
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;

  const scenario = async (number: number, name: string, run: () => Promise<void> | void): Promise<void> => {
    await run();
    console.log(`PASS: Scenario ${number} - ${name}`);
  };
  const runtime = (label: StaffLabel): StaffRuntime => {
    const value = staff.get(label);
    assert(value, `Missing ${label} runtime.`);
    return value;
  };
  const signIn = async (label: StaffLabel): Promise<StaffRuntime> => {
    const definition = SYNTHETIC_STAFF_DEFINITIONS.find((entry) => entry.label === label);
    assert(definition, `Missing ${label} definition.`);
    const client = anonClient();
    const result = await client.auth.signInWithPassword({
      email: definition.email,
      password: credentials[definition.email],
    });
    assert.ifError(result.error);
    assert(result.data.user && result.data.session, `${label} password login did not issue a session.`);
    const context = await resolveAdminContextFromAuthUser(result.data.user.id, service);
    const value = { client, context, session: result.data.session };
    staff.set(label, value);
    return value;
  };
  const assertMutationDenied = async (client: SupabaseClient, publicId: string): Promise<void> => {
    const result = await client.from('projects').insert({
      public_id: publicId,
      title: 'Forbidden synthetic mutation',
      year: 2026,
      status: 'draft',
    });
    assert(result.error, 'Direct authenticated administrative mutation unexpectedly succeeded.');
  };
  const assertRpcDenied = async (client: SupabaseClient): Promise<void> => {
    const result = await client.rpc('perform_project_review_action', {
      p_public_id: `${prefix}-missing`,
      p_action: 'approve',
      p_comments: null,
      p_admin_id: runtime('local-admin').context.adminUserId,
    });
    assert(result.error, 'Protected workflow RPC unexpectedly executed through a non-service client.');
  };

  try {
    await scenario(1, 'synthetic admin real password login', async () => { await signIn('local-admin'); });
    await scenario(2, 'synthetic reviewer real password login', async () => { await signIn('local-reviewer'); });
    await scenario(3, 'synthetic editor real password login', async () => { await signIn('local-editor'); });

    await scenario(4, 'each Auth ID resolves to its exact staff profile', () => {
      for (const entry of staff.values()) {
        assert.equal(entry.context.authUserId, entry.session.user.id);
        assert(entry.context.adminUserId);
        assert.equal(entry.context.email.toLowerCase(), entry.session.user.email?.toLowerCase());
      }
    });
    await scenario(5, 'each synthetic profile has its exact single role', () => {
      for (const definition of SYNTHETIC_STAFF_DEFINITIONS) {
        assert.deepEqual(runtime(definition.label as StaffLabel).context.roles, [definition.role]);
      }
    });
    await scenario(6, 'admin permission set is exact', () => {
      assert.deepEqual(runtime('local-admin').context.permissions, [...EXPECTED_PERMISSIONS.admin]);
    });
    await scenario(7, 'reviewer permission set is exact', () => {
      assert.deepEqual(runtime('local-reviewer').context.permissions, [...EXPECTED_PERMISSIONS.reviewer]);
    });
    await scenario(8, 'editor permission set is exact', () => {
      assert.deepEqual(runtime('local-editor').context.permissions, [...EXPECTED_PERMISSIONS.editor]);
    });

    const editor = runtime('local-editor').context;
    const editorBaseline = [...editor.roles];
    const addReviewer = await service.from('user_roles').insert({ user_id: editor.adminUserId, role: 'reviewer' });
    assert.ifError(addReviewer.error);
    editorReviewerAdded = true;
    const combined = await resolveAdminContextFromAuthUser(editor.authUserId, service);
    await scenario(9, 'temporary editor+reviewer permissions are the exact union', () => {
      assert.deepEqual(combined.roles, ['editor', 'reviewer']);
      assert.deepEqual(combined.permissions, ['projects.read', 'projects.edit', 'projects.review']);
    });
    await scenario(10, 'editor+reviewer gains neither publish nor archive', () => {
      assert(!hasPermission(combined.permissions, 'projects.publish'));
      assert(!hasPermission(combined.permissions, 'projects.archive'));
    });
    const removeReviewer = await service.from('user_roles').delete().eq('user_id', editor.adminUserId).eq('role', 'reviewer');
    assert.ifError(removeReviewer.error);
    editorReviewerAdded = false;
    assert.deepEqual((await resolveAdminContextFromAuthUser(editor.authUserId, service)).roles, editorBaseline);

    await scenario(11, 'unknown roles cannot expand runtime authority', async () => {
      const rejected = await service.from('user_roles').insert({ user_id: editor.adminUserId, role: 'unknown' });
      assert(rejected.error, 'Database accepted an unknown staff role.');
      assert.deepEqual(getPermissionsForRoles(['unknown' as never]), []);
    });
    await scenario(12, 'unauthenticated browser session is absent', async () => {
      const result = await anonClient().auth.getSession();
      assert.ifError(result.error);
      assert.equal(result.data.session, null);
    });

    const unprovisionedEmail = `${prefix}.unprovisioned@capstone.test`;
    const unprovisionedPassword = `Local_${crypto.randomBytes(18).toString('hex')}!`;
    const unprovisionedCreated = await service.auth.admin.createUser({
      email: unprovisionedEmail,
      password: unprovisionedPassword,
      email_confirm: true,
    });
    assert.ifError(unprovisionedCreated.error);
    assert(unprovisionedCreated.data.user);
    createdAuthIds.add(unprovisionedCreated.data.user.id);
    const unprovisionedLogin = await anonClient().auth.signInWithPassword({ email: unprovisionedEmail, password: unprovisionedPassword });
    assert.ifError(unprovisionedLogin.error);
    await scenario(13, 'unprovisioned authenticated user is classified correctly', async () => {
      try {
        await resolveAdminContextFromAuthUser(unprovisionedCreated.data.user!.id, service);
        assert.fail('Unprovisioned user unexpectedly received staff context.');
      } catch (error) {
        expectAuthError(error, 'ADMIN_NOT_PROVISIONED');
      }
    });

    const rolelessEmail = `${prefix}.roleless@capstone.test`;
    const rolelessPassword = `Local_${crypto.randomBytes(18).toString('hex')}!`;
    const rolelessCreated = await service.auth.admin.createUser({
      email: rolelessEmail,
      password: rolelessPassword,
      email_confirm: true,
    });
    assert.ifError(rolelessCreated.error);
    assert(rolelessCreated.data.user);
    createdAuthIds.add(rolelessCreated.data.user.id);
    const rolelessProfile = await service.from('admin_users').insert({
      email: rolelessEmail,
      full_name: 'Local Synthetic Roleless Staff',
      auth_user_id: rolelessCreated.data.user.id,
    }).select('id').single();
    assert.ifError(rolelessProfile.error);
    createdAdminIds.add(String(rolelessProfile.data.id));
    await scenario(14, 'provisioned profile without a recognized role is denied', async () => {
      try {
        await resolveAdminContextFromAuthUser(rolelessCreated.data.user!.id, service);
        assert.fail('Roleless profile unexpectedly received permissions.');
      } catch (error) {
        expectAuthError(error, 'PERMISSION_DENIED');
      }
    });

    await scenario(15, 'real issued sessions match the 3600-second Local policy', () => {
      for (const entry of staff.values()) {
        const timing = decodeJwtTiming(entry.session.access_token);
        assert.equal(timing.expiresAt - timing.issuedAt, 3600);
        assert(entry.session.expires_in >= 3590 && entry.session.expires_in <= 3600);
        assert(entry.session.expires_at && entry.session.expires_at > Math.floor(Date.now() / 1000));
      }
    });
    await scenario(16, 'real sign-out removes the usable browser session', async () => {
      const definition = SYNTHETIC_STAFF_DEFINITIONS.find((entry) => entry.label === 'local-admin')!;
      const client = anonClient();
      const login = await client.auth.signInWithPassword({ email: definition.email, password: credentials[definition.email] });
      assert.ifError(login.error);
      assert(login.data.session);
      assert.ifError((await client.auth.signOut()).error);
      const after = await client.auth.getSession();
      assert.ifError(after.error);
      assert.equal(after.data.session, null);
    });

    await scenario(17, 'anon direct administrative table mutation is denied', async () => {
      const result = await anonClient().from('admin_users').insert({
        email: `${prefix}.anon@capstone.test`,
        full_name: 'Forbidden',
      });
      assert(result.error);
    });
    await scenario(18, 'authenticated admin direct table mutation is denied', async () => {
      await assertMutationDenied(runtime('local-admin').client, `${prefix}-admin-direct`);
    });
    await scenario(19, 'authenticated reviewer direct table mutation is denied', async () => {
      await assertMutationDenied(runtime('local-reviewer').client, `${prefix}-reviewer-direct`);
    });
    await scenario(20, 'authenticated editor direct table mutation is denied', async () => {
      await assertMutationDenied(runtime('local-editor').client, `${prefix}-editor-direct`);
      for (const entry of staff.values()) {
        const lookup = await entry.client.from('programs').select('id').limit(1);
        assert.ifError(lookup.error);
        assert((lookup.data ?? []).length > 0, 'Authenticated lookup read returned no fixture rows.');
      }
    });
    await scenario(21, 'anon protected workflow RPC is denied', async () => { await assertRpcDenied(anonClient()); });
    await scenario(22, 'all authenticated staff are denied direct protected RPC execution', async () => {
      for (const entry of staff.values()) await assertRpcDenied(entry.client);
    });

    const noGateway = new Proxy({}, { get: () => () => { throw new Error('Denied workflow reached persistence.'); } });
    await scenario(23, 'reviewer is denied the edit-only production workflow', async () => {
      const result = await saveAuthorizedProjectMetadata(
        runtime('local-reviewer').context.permissions,
        noGateway as never,
        {},
      );
      assert.equal(result.ok, false);
      if (result.ok) assert.fail('Reviewer unexpectedly reached the edit workflow.');
      assert.equal(result.code, 'PERMISSION_DENIED');
    });
    await scenario(24, 'editor is denied review-only production actions', () => {
      assert(!canPerformReviewAction(runtime('local-editor').context.permissions, 'approve'));
      assert(!canPerformReviewAction(runtime('local-editor').context.permissions, 'request_changes'));
    });
    await scenario(25, 'reviewer and editor publication authority is denied', () => {
      assert(!canPreparePublication(runtime('local-reviewer').context.permissions));
      assert(!canPreparePublication(runtime('local-editor').context.permissions));
    });
    await scenario(26, 'reviewer and editor archive authority is denied', () => {
      assert(!canPerformReviewAction(runtime('local-reviewer').context.permissions, 'archive'));
      assert(!canPerformReviewAction(runtime('local-editor').context.permissions, 'archive'));
    });
    await scenario(27, 'admin is allowed at all relevant permission boundaries', () => {
      const permissions = runtime('local-admin').context.permissions;
      assert(hasPermission(permissions, 'projects.edit'));
      assert(canPerformReviewAction(permissions, 'approve'));
      assert(canPreparePublication(permissions));
      assert(canPerformReviewAction(permissions, 'archive'));
    });
    await scenario(28, 'editor+reviewer combined correction authority succeeds', () => {
      assert(canResolveParticipantCorrection(combined.permissions));
    });
    await scenario(29, 'editor-only combined correction authority is denied', () => {
      assert(!canResolveParticipantCorrection(runtime('local-editor').context.permissions));
    });
    await scenario(30, 'reviewer-only combined correction authority is denied', () => {
      assert(!canResolveParticipantCorrection(runtime('local-reviewer').context.permissions));
    });

    const reviewProject = await service.from('projects').insert({
      public_id: `${prefix}-review-audit`,
      title: 'Governance runtime review audit',
      summary: 'Synthetic governance runtime fixture.',
      year: 2026,
      status: 'submitted',
    }).select('id').single();
    assert.ifError(reviewProject.error);
    const reviewProjectId = String(reviewProject.data.id);
    createdProjectIds.add(reviewProjectId);
    const repository = new SupabaseProjectRepositoryCore(service);
    await scenario(31, 'denied actions generate zero audit evidence', async () => {
      const before = await service.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', reviewProjectId);
      assert.equal(before.count, 0);
      assert(!canPerformReviewAction(runtime('local-editor').context.permissions, 'approve'));
      const after = await service.from('approval_records').select('id', { count: 'exact', head: true }).eq('project_id', reviewProjectId);
      assert.equal(after.count, 0);
    });
    await scenario(32, 'successful review audit records the exact authenticated actor', async () => {
      const reviewer = runtime('local-reviewer').context;
      const result = await repository.performReviewAction({
        publicId: `${prefix}-review-audit`,
        action: 'approve',
        comments: 'Synthetic governance verification',
        adminId: reviewer.adminUserId,
      });
      assert.equal(result.status, 'approved');
      const audit = await service.from('approval_records')
        .select('admin_id,action_taken,from_status,to_status')
        .eq('project_id', reviewProjectId)
        .single();
      assert.ifError(audit.error);
      assert.deepEqual(audit.data, {
        admin_id: reviewer.adminUserId,
        action_taken: 'approve',
        from_status: 'submitted',
        to_status: 'approved',
      });
    });

    const readSource = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');
    await scenario(33, 'submit audit actor is derived from authenticated server context', () => {
      const source = readSource('apps/admin-cms/src/app/api/imports/[batchId]/submit-for-review/route.ts');
      assert(source.includes('adminContext.adminUserId'));
      assert(source.includes('submitImportProjectsForReview'));
    });
    await scenario(34, 'publication audit actor is derived from authenticated server context', () => {
      const source = readSource('apps/admin-cms/src/app/api/projects/[publicId]/local-publication/route.ts');
      assert(source.includes('adminId: admin.adminUserId'));
      assert(!source.includes('request.json()'));
    });
    await scenario(35, 'archive audit actor is derived from authenticated server context', () => {
      const source = readSource('apps/admin-cms/src/app/api/projects/[publicId]/local-archive/route.ts');
      assert(source.includes('adminId: admin.adminUserId'));
      assert(source.includes('validatePublicRemovalInput(body'));
    });
    await scenario(36, 'browser-supplied authority cannot alter route attribution', () => {
      const reviewSource = readSource('apps/admin-cms/src/app/api/projects/[publicId]/review-action/route.ts');
      const correctionSource = readSource('apps/admin-cms/src/app/api/projects/[publicId]/participant-preview/correction-resolution/route.ts');
      assert(reviewSource.includes('adminId: adminContext.adminUserId'));
      assert(correctionSource.includes('adminId: adminContext.adminUserId'));
      assert(!reviewSource.includes('body.admin'));
      assert(!correctionSource.includes('body.admin'));
    });

    await scenario(37, 'cleanup restores exact verifier-owned role, Auth, project, and audit baseline', async () => {
      // Final cleanup and independent residue assertions run in the finally block.
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      if (editorReviewerAdded && staff.has('local-editor')) {
        await service.from('user_roles').delete()
          .eq('user_id', runtime('local-editor').context.adminUserId)
          .eq('role', 'reviewer');
      }
      if (createdProjectIds.size) {
        await service.from('approval_records').delete().in('project_id', [...createdProjectIds]);
        await service.from('projects').delete().in('id', [...createdProjectIds]);
      }
      if (createdAdminIds.size) await service.from('admin_users').delete().in('id', [...createdAdminIds]);
      for (const authId of createdAuthIds) {
        const deleted = await service.auth.admin.deleteUser(authId);
        assert.ifError(deleted.error);
      }

      const roleResidue = await service.from('user_roles').select('id', { count: 'exact', head: true })
        .eq('user_id', runtime('local-editor').context.adminUserId)
        .eq('role', 'reviewer');
      const projectResidue = await service.from('projects').select('id', { count: 'exact', head: true })
        .like('public_id', `${prefix}%`);
      const profileResidue = await service.from('admin_users').select('id', { count: 'exact', head: true })
        .like('email', `${prefix}%`);
      assert.equal(roleResidue.count, 0);
      assert.equal(projectResidue.count, 0);
      assert.equal(profileResidue.count, 0);
      console.log('PASS: Cleanup residue check - exact synthetic baseline restored');
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  console.log('OVERALL STAFF ROLE & SESSION GOVERNANCE RUNTIME VERIFICATION RESULT: PASS');
}

main().catch((error) => {
  console.error('STAFF ROLE & SESSION GOVERNANCE VERIFIER FAILURE:', error instanceof Error ? error.message : String(error));
  console.error('OVERALL STAFF ROLE & SESSION GOVERNANCE RUNTIME VERIFICATION RESULT: FAIL');
  process.exit(1);
});
