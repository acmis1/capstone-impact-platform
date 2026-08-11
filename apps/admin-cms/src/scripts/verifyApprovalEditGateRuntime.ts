import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const root = path.resolve(__dirname, '../../../..');
const sql = (query: string) => execSync(`docker exec supabase_db_capstone-impact-platform psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c \"${query.replace(/\"/g, '\\\"')}\"`, { cwd: root, encoding: 'utf8' });

async function main() {
  const raw = execSync(`\"${path.join(root, 'node_modules/.bin/supabase')}\" status --workdir \"${path.join(root, 'infra')}\" -o env`, { cwd: root, encoding: 'utf8' });
  const env = parseSupabaseCliEnv(raw);
  if (!env.API_URL || !env.SERVICE_ROLE_KEY || !isLoopbackUrl(env.API_URL)) throw new Error('Local loopback Supabase is required.');
  const client = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const suffix = Date.now().toString(36);
  const publicId = `approval-gate-${suffix}`;
  const ids = JSON.parse(sql(`SELECT json_build_object('program', (SELECT id::text FROM public.programs LIMIT 1), 'discipline', (SELECT id::text FROM public.disciplines LIMIT 1), 'industry', (SELECT id::text FROM public.industry_categories LIMIT 1))`));
  sql(`INSERT INTO public.projects(public_id,title,summary,year,program_id,program_name,discipline,industry,status) VALUES ('${publicId}','Before','Before',2026,'${ids.program}'::uuid,'P','D','I','approved')`);
  try {
    const row = JSON.parse(sql(`SELECT json_build_object('updated_at',updated_at) FROM public.projects WHERE public_id='${publicId}'`));
    const args = { p_public_id: publicId, p_title: 'After', p_summary: 'After', p_background: '', p_solution: '', p_year: 2026, p_program_id: ids.program, p_discipline_ids: [ids.discipline], p_industry_category_ids: [ids.industry], p_expected_updated_at: row.updated_at };
    const rejected = await client.rpc('update_project_metadata', args);
    if (rejected.error || rejected.data?.resultCode !== 'APPROVAL_REOPEN_REQUIRED') throw new Error('Approved metadata mutation was not rejected.');
    const review = await client.rpc('perform_project_review_action', { p_public_id: publicId, p_action: 'request_changes', p_comments: 'runtime', p_admin_id: JSON.parse(sql(`SELECT json_build_object('id',id::text) FROM public.admin_users LIMIT 1`)).id });
    if (review.error || review.data?.status !== 'changes_requested') throw new Error('Approved reopening failed.');
    const updated = JSON.parse(sql(`SELECT json_build_object('updated_at',updated_at) FROM public.projects WHERE public_id='${publicId}'`));
    const mutable = await client.rpc('update_project_metadata', { ...args, p_expected_updated_at: updated.updated_at });
    if (mutable.error || mutable.data?.resultCode !== 'SUCCESS') throw new Error('changes_requested metadata mutation failed.');
    console.log('OVERALL APPROVAL EDIT GATE RUNTIME VERIFICATION RESULT: PASS');
  } finally { sql(`DELETE FROM public.approval_records WHERE project_id IN (SELECT id FROM public.projects WHERE public_id='${publicId}'); DELETE FROM public.projects WHERE public_id='${publicId}'`); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
