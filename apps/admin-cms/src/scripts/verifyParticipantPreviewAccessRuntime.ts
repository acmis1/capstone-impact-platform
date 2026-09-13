import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createPublicFeedRuntimeHarness } from './publicFeedRuntimeSupport';

type RpcResult = { resultCode?: string };

async function main(): Promise<void> {
  const harness = await createPublicFeedRuntimeHarness();
  const suffix = randomBytes(5).toString('hex');
  const snapshot = { title: 'Synthetic access observation', summary: null, year: 2026 };
  const insertPreview = async (state: 'active' | 'expired' | 'revoked' = 'active') => {
    const project = await harness.createProject(`preview-access-${state}-${suffix}-${randomBytes(2).toString('hex')}`);
    const id = randomUUID();
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const revoked = state === 'revoked';
    const result = await harness.db.from('participant_previews').insert({
      id, project_id: project.id, token_hash: tokenHash, snapshot, media_snapshot: [],
      status: revoked ? 'revoked' : 'active',
      expires_at: state === 'expired' ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
      revoked_at: revoked ? new Date().toISOString() : null,
    });
    assert.equal(result.error, null, 'Synthetic preview fixture creation failed.');
    return { ...project, id, tokenHash };
  };
  const observe = async (id: string, tokenHash: string): Promise<RpcResult> => {
    const result = await harness.db.rpc('record_participant_preview_response_prepared', {
      p_preview_id: id, p_token_hash: tokenHash,
    });
    assert.equal(result.error, null, 'Service-role observation RPC failed.');
    assert.ok(result.data && typeof result.data === 'object' && !Array.isArray(result.data));
    return result.data as RpcResult;
  };
  const observationCount = async (id: string) => {
    const result = await harness.db.from('participant_preview_access_observations')
      .select('participant_preview_id', { count: 'exact', head: true })
      .eq('participant_preview_id', id);
    assert.equal(result.error, null);
    return result.count ?? 0;
  };
  const exactState = (id: string) => harness.psql(`SELECT pg_catalog.jsonb_build_object(
    'project_status',(SELECT p.status FROM public.projects p JOIN public.participant_previews pp ON pp.project_id=p.id WHERE pp.id='${id}'::uuid),
    'preview',(SELECT pg_catalog.to_jsonb(pp) - 'token_hash' FROM public.participant_previews pp WHERE pp.id='${id}'::uuid),
    'confirmations',(SELECT pg_catalog.count(*) FROM public.participant_preview_confirmations c WHERE c.participant_preview_id='${id}'::uuid),
    'corrections',(SELECT pg_catalog.count(*) FROM public.participant_preview_correction_requests c WHERE c.participant_preview_id='${id}'::uuid),
    'approval_history',(SELECT pg_catalog.count(*) FROM public.approval_records a JOIN public.participant_previews pp ON pp.project_id=a.project_id WHERE pp.id='${id}'::uuid)
  )::text;`);

  assert.equal(harness.psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '57');
  assert.equal(harness.psql("SELECT has_table_privilege('service_role','public.participant_preview_access_observations','SELECT')::text || '|' || has_table_privilege('service_role','public.participant_preview_access_observations','INSERT')::text || '|' || has_table_privilege('anon','public.participant_preview_access_observations','SELECT')::text || '|' || has_table_privilege('authenticated','public.participant_preview_access_observations','SELECT')::text;"), 'true|false|false|false');
  assert.equal(harness.psql("SELECT (NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS proc CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) AS acl WHERE proc.oid = 'public.record_participant_preview_response_prepared(uuid,text)'::regprocedure AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'))::text || '|' || has_function_privilege('anon','public.record_participant_preview_response_prepared(uuid,text)','EXECUTE')::text || '|' || has_function_privilege('authenticated','public.record_participant_preview_response_prepared(uuid,text)','EXECUTE')::text || '|' || has_function_privilege('service_role','public.record_participant_preview_response_prepared(uuid,text)','EXECUTE')::text;"), 'true|false|false|true');

  const first = await insertPreview();
  const stateBefore = exactState(first.id);
  assert.equal((await observe(first.id, first.tokenHash)).resultCode, 'OBSERVED');
  const firstTimestamp = await harness.db.from('participant_preview_access_observations')
    .select('first_response_prepared_at').eq('participant_preview_id', first.id).single();
  assert.equal(firstTimestamp.error, null);
  assert.equal((await observe(first.id, first.tokenHash)).resultCode, 'OBSERVED');
  const repeatedTimestamp = await harness.db.from('participant_preview_access_observations')
    .select('first_response_prepared_at').eq('participant_preview_id', first.id).single();
  assert.deepEqual(repeatedTimestamp.data, firstTimestamp.data);
  assert.equal(await observationCount(first.id), 1);
  assert.equal(exactState(first.id), stateBefore, 'Observation changed confirmation, correction, workflow, preview, or approval history.');

  const concurrent = await insertPreview();
  const concurrentResults = await Promise.all(Array.from({ length: 12 }, () => observe(concurrent.id, concurrent.tokenHash)));
  assert.ok(concurrentResults.every((result) => result.resultCode === 'OBSERVED'));
  assert.equal(await observationCount(concurrent.id), 1);

  for (const fixture of [await insertPreview('expired'), await insertPreview('revoked')]) {
    assert.equal((await observe(fixture.id, fixture.tokenHash)).resultCode, 'NOT_FOUND');
    assert.equal(await observationCount(fixture.id), 0);
  }
  assert.equal((await observe(randomUUID(), 'a'.repeat(64))).resultCode, 'NOT_FOUND');
  assert.equal((await observe(concurrent.id, 'b'.repeat(64))).resultCode, 'NOT_FOUND');
  assert.equal((await observe(concurrent.id, 'invalid')).resultCode, 'NOT_FOUND');
  assert.equal(await observationCount(concurrent.id), 1);

  const directWrite = await harness.db.from('participant_preview_access_observations').insert({
    participant_preview_id: randomUUID(), first_response_prepared_at: new Date().toISOString(),
  });
  assert.ok(directWrite.error, 'A direct service-role observation write unexpectedly succeeded.');

  const anon = createClient(harness.apiUrl, harness.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  assert.ok((await anon.rpc('record_participant_preview_response_prepared', {
    p_preview_id: concurrent.id, p_token_hash: concurrent.tokenHash,
  })).error, 'Anon unexpectedly executed the observation RPC.');
  const noAuth = await fetch(`${harness.apiUrl}/rest/v1/rpc/record_participant_preview_response_prepared`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p_preview_id: concurrent.id, p_token_hash: concurrent.tokenHash }),
  });
  assert.ok(noAuth.status === 401 || noAuth.status === 403, `Unauthenticated RPC returned ${noAuth.status}.`);
  let authenticatedDenied = false;
  try {
    harness.psql(`SET ROLE authenticated; SELECT public.record_participant_preview_response_prepared('${concurrent.id}'::uuid,'${concurrent.tokenHash}');`);
  } catch { authenticatedDenied = true; }
  assert.equal(authenticatedDenied, true, 'Authenticated unexpectedly executed the observation RPC.');

  const retained = await harness.db.rpc('revoke_participant_preview', {
    p_public_id: first.publicId, p_admin_id: harness.adminId,
  });
  assert.equal(retained.error, null);
  assert.equal((retained.data as RpcResult).resultCode, 'SUCCESS');
  assert.equal(await observationCount(first.id), 1, 'Later revocation removed the first observation.');
  assert.equal((await observe(first.id, first.tokenHash)).resultCode, 'NOT_FOUND');

  const raced = await insertPreview();
  const [raceObservation, raceRevocation] = await Promise.all([
    observe(raced.id, raced.tokenHash),
    harness.db.rpc('revoke_participant_preview', { p_public_id: raced.publicId, p_admin_id: harness.adminId }),
  ]);
  assert.equal(raceRevocation.error, null);
  assert.equal((raceRevocation.data as RpcResult).resultCode, 'SUCCESS');
  const racedCount = await observationCount(raced.id);
  assert.ok(
    (raceObservation.resultCode === 'OBSERVED' && racedCount === 1)
      || (raceObservation.resultCode === 'NOT_FOUND' && racedCount === 0),
    'Revocation race produced evidence inconsistent with row-lock ordering.',
  );

  console.log('PASS: preview response observations are exact, idempotent, concurrent-safe, fail closed, privilege-narrow, and retained after later revocation');
  console.log('PASS: observation collection leaves confirmation, correction, workflow and approval history unchanged');
  console.log('HOSTED_SYSTEMS_CONTACTED = NO');
}

void main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : 'PREVIEW_ACCESS_RUNTIME_FAILED'}`);
  process.exitCode = 1;
});
