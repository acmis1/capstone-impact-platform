import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { validateCredentialsStructure } from '../local-development/localStaffAuthVerification';
import { SupabaseParticipantPreviewRepositoryCore } from '../repositories/SupabaseParticipantPreviewRepositoryCore';

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

  const credentials = validateCredentialsStructure(JSON.parse(
    fs.readFileSync(path.join(root, 'apps/admin-cms/.local-users.json'), 'utf8'),
  ));
  const password = credentials['local.admin@capstone.test'];
  if (!password) throw new Error('Local synthetic admin credentials are unavailable.');

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

  const cookieJar = new Map<string, string>();
  const authClient = createServerClient(env.API_URL, env.ANON_KEY, {
    cookies: {
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => cookieJar.set(name, value)),
    },
  });
  verificationStage = 'synthetic admin sign-in';
  const signIn = await authClient.auth.signInWithPassword({
    email: 'local.admin@capstone.test',
    password,
  });
  if (signIn.error || !signIn.data.session) throw new Error('Local synthetic admin sign-in failed.');

  let baseUrl = 'http://127.0.0.1:3000';
  let child: ChildProcess | null = null;
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

  try {
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
      if (!body.includes(project.title) || !body.includes('Workflow State:') || !body.includes('Project Metadata')) {
        throw new Error(`Required project detail markers missing: ${project.publicId}`);
      }
      const evidence = projectEvidence.find((item) => item.publicId === project.publicId)!;
      console.log(`PASS: ${project.publicId} detail rendered (status=${evidence.status}, activePreview=${evidence.activePreview}).`);
    }

    console.log('PASS: Authenticated dashboard-to-project-detail navigation rendered core metadata for two workflow states.');
  } finally {
    try {
      await authClient.auth.signOut();
    } finally {
      if (child) await stopProcessTree(child);
    }
  }
}

run().catch(() => {
  console.error(`Project detail runtime verification failed during ${verificationStage}.`);
  process.exitCode = 1;
});
