import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';
import {
  PROJECT_AUDIT_HISTORY_SELECT,
  parseAuditHistoryRow,
  type AuditHistoryView,
} from '../projects/projectDetailAuxiliaryData';

const FALLBACK_PORT = 3100;
let verificationStage = 'initialization';
const PROJECTS = [
  { publicId: '2026-agri-iot', title: 'Agricultural IoT Hydration Roster' },
  { publicId: '2026-vr-rehab', title: 'VR Rehabilitation Roster' },
] as const;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /f /t`, { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      await delay(300);
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }
  } catch {
    // The process may already have exited between the checks above.
  }
}

async function waitForApp(child: ChildProcess, baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Admin application exited before becoming ready.');
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.status === 200) return;
    } catch {
      // Keep polling within the bounded startup deadline.
    }
    await delay(500);
  }
  throw new Error('Admin application readiness timed out.');
}

async function isExistingCapstoneApp(baseUrl: string): Promise<boolean> {
  try {
    const [health, login] = await Promise.all([
      fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3_000) }),
      fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(3_000) }),
    ]);
    const loginBody = await login.text();
    return health.status === 200 && login.status === 200 && loginBody.includes('Capstone Impact Platform');
  } catch {
    return false;
  }
}

function setApprovalRecordsSelect(enabled: boolean): void {
  execFileSync('docker', [
    'exec',
    'supabase_db_capstone-impact-platform',
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `${enabled ? 'GRANT' : 'REVOKE'} SELECT ON TABLE public.approval_records ${enabled ? 'TO' : 'FROM'} service_role;`,
  ], { stdio: 'ignore' });
}

async function createAuditAcceptanceFixture(serviceClient: SupabaseClient) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const publicId = `detail-audit-${suffix}`;
  const metadataActor = {
    id: randomUUID(),
    fullName: `Detail Metadata Actor ${suffix}`,
    email: `detail-metadata-${suffix}@example.test`,
  };
  const legacyActor = {
    id: randomUUID(),
    fullName: `Detail Legacy Actor ${suffix}`,
    email: `detail-legacy-${suffix}@example.test`,
  };
  let projectId: string | null = null;

  const cleanup = async () => {
    if (projectId) await serviceClient.from('projects').delete().eq('id', projectId);
    await serviceClient.from('admin_users').delete().in('id', [metadataActor.id, legacyActor.id]);
  };

  try {
    const [programResult, disciplineResult, industryResult] = await Promise.all([
      serviceClient.from('programs').select('id,name').order('id').limit(1).single(),
      serviceClient.from('disciplines').select('id,name').order('id').limit(1).single(),
      serviceClient.from('industry_categories').select('id,name').order('id').limit(1).single(),
    ]);
    if (programResult.error || disciplineResult.error || industryResult.error) {
      throw new Error('Project-detail audit verifier lookup fixtures are unavailable.');
    }
    const program = programResult.data;
    const discipline = disciplineResult.data;
    const industry = industryResult.data;

    const actors = await serviceClient.from('admin_users').insert([
      { id: metadataActor.id, email: metadataActor.email, full_name: metadataActor.fullName },
      { id: legacyActor.id, email: legacyActor.email, full_name: legacyActor.fullName },
    ]);
    if (actors.error) throw new Error('Project-detail audit verifier actors could not be created.');
    const roles = await serviceClient.from('user_roles').insert([
      { user_id: metadataActor.id, role: 'editor' },
      { user_id: legacyActor.id, role: 'reviewer' },
    ]);
    if (roles.error) throw new Error('Project-detail audit verifier roles could not be created.');

    const projectResult = await serviceClient.from('projects').insert({
      public_id: publicId,
      title: 'Detail audit original title',
      summary: 'Detail audit summary',
      background: 'Detail audit background',
      solution: 'Detail audit solution',
      year: 2026,
      program_id: program.id,
      program_name: program.name,
      discipline: discipline.name,
      industry: industry.name,
      status: 'submitted',
      poster_text_public: 'Detail audit poster full text',
      accessibility_text_public: 'Detail audit accessibility text',
    }).select('id').single();
    if (projectResult.error || !projectResult.data) throw new Error('Project-detail audit verifier project could not be created.');
    projectId = projectResult.data.id;
    const mappings = await Promise.all([
      serviceClient.from('project_disciplines').insert({ project_id: projectId, discipline_id: discipline.id }),
      serviceClient.from('project_industry_categories').insert({ project_id: projectId, industry_category_id: industry.id }),
    ]);
    if (mappings.some((result) => result.error)) throw new Error('Project-detail audit verifier relationships could not be created.');

    const legacyReview = await serviceClient.rpc('perform_project_review_action', {
      p_public_id: publicId,
      p_action: 'request_changes',
      p_comments: 'Verifier-owned legacy review action',
      p_admin_id: legacyActor.id,
    });
    if (legacyReview.error || !legacyReview.data?.auditRecordId) throw new Error('Project-detail legacy review audit could not be created.');
    const current = await serviceClient.from('projects').select('updated_at').eq('id', projectId).single();
    if (current.error || !current.data) throw new Error('Project-detail metadata version could not be read.');
    const metadataUpdate = await serviceClient.rpc('update_project_metadata', {
      p_public_id: publicId,
      p_title: 'Detail audit revised title',
      p_summary: 'Detail audit summary',
      p_background: 'Detail audit background',
      p_solution: 'Detail audit solution',
      p_year: 2026,
      p_program_id: program.id,
      p_discipline_ids: [discipline.id],
      p_industry_category_ids: [industry.id],
      p_expected_updated_at: current.data.updated_at,
      p_admin_id: metadataActor.id,
      p_poster_text: 'Detail audit poster full text',
      p_accessibility_text: 'Detail audit accessibility text',
    });
    if (metadataUpdate.error || metadataUpdate.data?.resultCode !== 'SUCCESS' || !metadataUpdate.data.auditRecordId) {
      throw new Error('Project-detail metadata audit could not be created.');
    }

    const auditIds = [String(legacyReview.data.auditRecordId), String(metadataUpdate.data.auditRecordId)];
    const tie = await serviceClient.from('approval_records').update({ created_at: '2026-08-13T12:00:00.000Z' }).in('id', auditIds);
    if (tie.error) throw new Error('Project-detail audit tie-break fixture could not be prepared.');

    const readHistory = async (): Promise<AuditHistoryView[]> => {
      const result = await serviceClient
        .from('approval_records')
        .select(PROJECT_AUDIT_HISTORY_SELECT)
        .eq('project_id', projectId!)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
      if (result.error) throw new Error('Production project-detail audit projection failed against Local Supabase.');
      return (result.data ?? []).map(parseAuditHistoryRow);
    };

    const initialHistory = await readHistory();
    const metadataEvent = initialHistory.find((record) => record.id === metadataUpdate.data.auditRecordId);
    const legacyEvent = initialHistory.find((record) => record.id === legacyReview.data.auditRecordId);
    if (!metadataEvent || metadataEvent.actorFullName !== metadataActor.fullName || metadataEvent.actorEmail !== metadataActor.email
      || JSON.stringify(metadataEvent.metadataEventDetails?.changedFields) !== JSON.stringify(['title'])) {
      throw new Error('Production project-detail metadata audit parsing is incorrect.');
    }
    if (!legacyEvent || legacyEvent.actorFullName !== legacyActor.fullName || legacyEvent.actorEmail !== legacyActor.email
      || legacyEvent.metadataEventDetails !== null) {
      throw new Error('Production project-detail legacy actor fallback is incorrect.');
    }
    const expectedOrder = [...auditIds].sort().reverse();
    if (JSON.stringify(initialHistory.map((record) => record.id)) !== JSON.stringify(expectedOrder)) {
      throw new Error('Production project-detail audit ordering is not created_at DESC, id DESC.');
    }

    const removed = await serviceClient.from('admin_users').delete().eq('id', metadataActor.id);
    if (removed.error) throw new Error('Verifier-owned snapshot actor could not be removed safely.');
    const retainedEvent = (await readHistory()).find((record) => record.id === metadataUpdate.data.auditRecordId);
    if (!retainedEvent || retainedEvent.actorFullName !== metadataActor.fullName || retainedEvent.actorEmail !== metadataActor.email) {
      throw new Error('Snapshot-backed metadata audit did not survive actor removal.');
    }

    return { publicId, title: 'Detail audit revised title', metadataActor, legacyActor, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function createAuthenticatedAdminFixture(serviceClient: SupabaseClient) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `detail-auth-${suffix}@capstone.test`;
  const password = `${randomUUID()}Aa1!`;
  const adminUserId = randomUUID();
  let authUserId: string | null = null;

  const cleanup = async () => {
    await serviceClient.from('admin_users').delete().eq('id', adminUserId);
    if (authUserId) await serviceClient.auth.admin.deleteUser(authUserId);
  };

  try {
    const created = await serviceClient.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error('Verifier-owned Local Auth user could not be created.');
    authUserId = created.data.user.id;
    const profile = await serviceClient.from('admin_users').insert({
      id: adminUserId,
      email,
      full_name: `Project Detail Admin ${suffix}`,
      auth_user_id: authUserId,
    });
    if (profile.error) throw new Error('Verifier-owned Local admin profile could not be created.');
    const role = await serviceClient.from('user_roles').insert({ user_id: adminUserId, role: 'admin' });
    if (role.error) throw new Error('Verifier-owned Local admin role could not be created.');
    return { email, password, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function run(): Promise<void> {
  verificationStage = 'Local Supabase credential discovery';
  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const rawEnv = execSync(`"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const env = parseSupabaseCliEnv(rawEnv);
  if (!env.API_URL || !env.ANON_KEY || !env.SERVICE_ROLE_KEY || !isLoopbackUrl(env.API_URL)) {
    throw new Error('Verified loopback Local Supabase credentials are unavailable.');
  }

  const serviceClient = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const previewRepository = new SupabaseParticipantPreviewRepositoryCore(serviceClient);
  const projectEvidence: Array<{ publicId: string; status: string; activePreview: boolean }> = [];

  verificationStage = 'seeded project and preview repository reads';
  for (const expected of PROJECTS) {
    const { data: project, error } = await serviceClient
      .from('projects')
      .select('id, status')
      .eq('public_id', expected.publicId)
      .maybeSingle();
    if (error || !project) throw new Error(`Seeded project unavailable: ${expected.publicId}`);
    const activePreview = await previewRepository.getActivePreview(project.id);
    await previewRepository.getCorrectionResolutionStatus(project.id);
    projectEvidence.push({ publicId: expected.publicId, status: String(project.status), activePreview: Boolean(activePreview) });
  }

  verificationStage = 'production audit projection acceptance fixture';
  const auditFixture = await createAuditAcceptanceFixture(serviceClient);
  let authenticatedAdminFixture: Awaited<ReturnType<typeof createAuthenticatedAdminFixture>>;
  try {
    authenticatedAdminFixture = await createAuthenticatedAdminFixture(serviceClient);
  } catch (error) {
    await auditFixture.cleanup();
    throw error;
  }
  const cookieJar = new Map<string, string>();
  const authClient = createServerClient(env.API_URL, env.ANON_KEY, {
    cookies: {
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => cookieJar.set(name, value)),
    },
  });
  let baseUrl = 'http://127.0.0.1:3000';
  let child: ChildProcess | null = null;
  let approvalSelectRevoked = false;

  try {
    verificationStage = 'synthetic admin sign-in';
    const signIn = await authClient.auth.signInWithPassword({
      email: authenticatedAdminFixture.email,
      password: authenticatedAdminFixture.password,
    });
    if (signIn.error || !signIn.data.session) throw new Error('Local synthetic admin sign-in failed.');

    if (!(await isExistingCapstoneApp(baseUrl))) {
      baseUrl = `http://127.0.0.1:${FALLBACK_PORT}`;
      const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      child = spawn(npmCommand, ['run', 'dev'], {
        cwd: path.join(root, 'apps/admin-cms'),
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(FALLBACK_PORT) },
      });
      child.stdout?.resume();
      child.stderr?.resume();
    }

    verificationStage = 'Admin application startup';
    if (child) await waitForApp(child, baseUrl);
    const cookieHeader = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
    const request = (pathname: string) => fetch(`${baseUrl}${pathname}`, {
      headers: { cookie: cookieHeader },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });

    verificationStage = 'authenticated dashboard navigation';
    const dashboard = await request('/admin');
    const dashboardBody = await dashboard.text();
    if (dashboard.status !== 200 || dashboard.url.includes('/login')) throw new Error('Authenticated dashboard navigation failed.');
    for (const project of PROJECTS) {
      if (!dashboardBody.includes(`/admin/projects/${project.publicId}`)) {
        throw new Error(`Dashboard project link unavailable: ${project.publicId}`);
      }
    }

    for (const project of PROJECTS) {
      verificationStage = `authenticated project detail navigation (${project.publicId})`;
      const response = await request(`/admin/projects/${project.publicId}`);
      const body = await response.text();
      if (response.status !== 200 || response.url.includes('/login')) throw new Error(`Authenticated project navigation failed: ${project.publicId}`);
      if (body.includes('Project Details Unavailable')) throw new Error(`Project detail fallback rendered: ${project.publicId}`);
      if (!body.includes(project.title) || !body.includes('Public ID:') || !body.includes('Project Overview')) {
        throw new Error(`Required project detail markers missing: ${project.publicId}`);
      }
      const evidence = projectEvidence.find((item) => item.publicId === project.publicId)!;
      console.log(`PASS: ${project.publicId} detail rendered (status=${evidence.status}, activePreview=${evidence.activePreview}).`);
    }

    verificationStage = 'production audit query and all-event actor rendering';
    const auditResponse = await request(`/admin/projects/${auditFixture.publicId}`);
    const auditBody = await auditResponse.text();
    if (auditResponse.status !== 200 || auditResponse.url.includes('/login')
      || auditBody.includes('Project Details Unavailable')
      || !auditBody.includes(auditFixture.title)
      || !auditBody.includes(auditFixture.metadataActor.fullName)
      || !auditBody.includes(auditFixture.legacyActor.fullName)) {
      throw new Error('Project detail did not render snapshot and legacy actors for all audit event types.');
    }
    console.log('PASS: Production bounded audit query parsed metadata details, legacy fallback, snapshot retention, and deterministic ordering.');
    console.log('PASS: Project detail rendered actors for metadata and legacy review events.');

    verificationStage = 'approval_records failure isolation';
    setApprovalRecordsSelect(false);
    approvalSelectRevoked = true;
    try {
      const isolatedResponse = await request(`/admin/projects/${auditFixture.publicId}`);
      const isolatedBody = await isolatedResponse.text();
      if (isolatedResponse.status !== 200
        || isolatedBody.includes('Project Details Unavailable')
        || !isolatedBody.includes(auditFixture.title)
        || !isolatedBody.includes('Project metadata')
        || !isolatedBody.includes('Audit history is temporarily unavailable.')) {
        throw new Error('Audit query failure erased the base project or independently healthy metadata editor.');
      }
      console.log('PASS: approval_records failure stayed isolated from the base project and metadata editor.');
    } finally {
      setApprovalRecordsSelect(true);
      approvalSelectRevoked = false;
    }

    console.log('PASS: Authenticated dashboard-to-project-detail navigation rendered core metadata for two workflow states.');
  } finally {
    try {
      if (approvalSelectRevoked) setApprovalRecordsSelect(true);
    } finally {
      try {
        await authClient.auth.signOut();
      } finally {
        try {
          if (child) await stopProcessTree(child);
        } finally {
          try {
            await auditFixture.cleanup();
          } finally {
            await authenticatedAdminFixture.cleanup();
          }
        }
      }
    }
  }
}

run().catch(() => {
  console.error(`Project detail runtime verification failed during ${verificationStage}.`);
  process.exitCode = 1;
});
