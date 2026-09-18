import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  assertDatabaseContainerOwned,
  readDisposableStackEnv,
  runDisposablePsql,
  type DisposableStackIdentity,
} from '../recovery/disposableSupabaseStack';
import { createLayoutConfigFromStock, LAYOUT_TEMPLATE_IDS } from '../domain/layoutConfig';

const PRIVATE_BUCKET = 'project-drafts-private';
const MIGRATION_58_VERSION = '20260914100000';
const MIGRATION_57_VERSION = '20260911120000';

const legacyLayoutConfig = {
  templateId: 'poster_showcase', featuredMedia: 'poster',
  sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
  hiddenSections: [],
};

const configA = {
  templateId: 'poster_showcase', featuredMedia: 'poster',
  sectionOrder: ['team', 'background', 'solution', 'snapshots', 'video', 'links', 'citations', 'accessibilityText'],
  hiddenSections: ['video'],
};
const configB = {
  templateId: 'technical_detail', featuredMedia: 'snapshots',
  sectionOrder: ['solution', 'snapshots', 'background', 'team', 'video', 'links', 'citations', 'accessibilityText'],
  hiddenSections: ['video', 'citations'],
};

async function requireData<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const result = await query;
  if (result.error || result.data === null || result.data === undefined) throw new Error('LAYOUT_RUNTIME_QUERY_FAILED');
  return result.data as NonNullable<T>;
}

async function createStaff(client: SupabaseClient, suffix: string, role: 'admin' | 'editor') {
  const email = `layout-runtime-${role}-${suffix}@example.invalid`;
  const auth = await client.auth.admin.createUser({
    email,
    password: `Local_${randomBytes(18).toString('hex')}!`,
    email_confirm: true,
  });
  assert.ifError(auth.error);
  assert(auth.data.user);
  const profile = await requireData(client.from('admin_users').insert({
    email,
    full_name: `Layout runtime ${role}`,
    auth_user_id: auth.data.user.id,
  }).select('id').single());
  await requireData(client.from('user_roles').insert({ user_id: profile.id, role }).select('id'));
  return String(profile.id);
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>) {
  return requireData(client.rpc(name, args)) as Promise<Record<string, unknown>>;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface LayoutRecipeUpgradeBaseline {
  adminId: string;
  retainedProjectIds: string[];
  retainedPublicIds: string[];
  retainedPreviewIds: string[];
  feedOperationId: string;
  feedVersionId: string;
  feedContent: string;
  stateFingerprint: string;
}

function captureUpgradeState(identity: DisposableStackIdentity, baseline: Omit<LayoutRecipeUpgradeBaseline, 'stateFingerprint'>): string {
  const projectIds = baseline.retainedProjectIds.map((id) => `${sqlLiteral(id)}::uuid`).join(',');
  const previewIds = baseline.retainedPreviewIds.map((id) => `${sqlLiteral(id)}::uuid`).join(',');
  const command = `COPY (SELECT pg_catalog.jsonb_build_object(
    'staff',(SELECT pg_catalog.to_jsonb(a) FROM public.admin_users a WHERE a.id=${sqlLiteral(baseline.adminId)}::uuid),
    'roles',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.id) FROM public.user_roles r WHERE r.user_id=${sqlLiteral(baseline.adminId)}::uuid),
    'projects',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.id) FROM public.projects p WHERE p.id IN (${projectIds})),
    'previews',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pp) - 'layout_config_snapshot' ORDER BY pp.id) FROM public.participant_previews pp WHERE pp.id IN (${previewIds})),
    'media',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.id) FROM public.media_assets m WHERE m.project_id IN (${projectIds})),
    'operation',(SELECT pg_catalog.to_jsonb(o) FROM public.public_feed_operations o WHERE o.id=${sqlLiteral(baseline.feedOperationId)}::uuid),
    'version',(SELECT pg_catalog.to_jsonb(v) FROM public.public_feed_versions v WHERE v.id=${sqlLiteral(baseline.feedVersionId)}::uuid),
    'members',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(vm) ORDER BY vm.ordinal) FROM public.public_feed_version_members vm WHERE vm.version_id=${sqlLiteral(baseline.feedVersionId)}::uuid),
    'head',(SELECT pg_catalog.to_jsonb(h) FROM public.public_feed_head h WHERE h.last_operation_id=${sqlLiteral(baseline.feedOperationId)}::uuid)
  )::text) TO STDOUT;`;
  return runDisposablePsql(identity, { command, singleTransaction: true }).trim();
}

/** Seeds representative retained state while the disposable stack is still exactly at Migration 57. */
export async function seedLayoutRecipeUpgradeBaseline(
  repositoryRoot: string,
  identity: DisposableStackIdentity,
): Promise<LayoutRecipeUpgradeBaseline> {
  assertDatabaseContainerOwned(identity);
  assert.equal(runDisposablePsql(identity, {
    command: 'COPY (SELECT count(*) FROM supabase_migrations.schema_migrations) TO STDOUT;',
    singleTransaction: true,
  }).trim(), '57');
  assert.equal(runDisposablePsql(identity, {
    command: 'COPY (SELECT max(version) FROM supabase_migrations.schema_migrations) TO STDOUT;',
    singleTransaction: true,
  }).trim(), MIGRATION_57_VERSION);

  const env = readDisposableStackEnv(repositoryRoot, identity);
  const client = createClient(env.apiUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const suffix = randomBytes(5).toString('hex');
  const adminId = await createStaff(client, `upgrade-${suffix}`, 'admin');
  const retainedProjects = [
    { title: 'Retained historical layout project', layoutConfig: legacyLayoutConfig },
    ...LAYOUT_TEMPLATE_IDS.map((templateId) => ({
      title: `Retained ${templateId} stock project`,
      layoutConfig: createLayoutConfigFromStock(templateId),
    })),
  ].map((project, index) => ({
    ...project,
    id: randomUUID(),
    publicId: `layout-upgrade-${suffix}-${index + 1}`,
  }));
  await requireData(client.from('projects').insert(retainedProjects.map((project) => ({
    id: project.id, public_id: project.publicId, title: project.title, summary: 'Summary',
    background: 'Background', solution: 'Solution', year: 2026, status: 'approved',
    team_members: ['Participant'], poster_text_public: 'Poster full text',
    accessibility_text_public: 'Poster description', layout_config: project.layoutConfig,
  }))).select('id'));

  const storagePath = `drafts/${retainedProjects[0].publicId}/snapshot_image/retained-results.png`;
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assert.equal((await client.storage.from(PRIVATE_BUCKET).upload(storagePath, imageBytes, {
    contentType: 'image/png', upsert: false,
  })).error, null);
  await requireData(client.from('media_assets').insert({
    project_id: retainedProjects[0].id, asset_type: 'snapshot_image', gallery_position: 1,
    file_name: 'retained-results.png', storage_bucket: PRIVATE_BUCKET, storage_path: storagePath,
    mime_type: 'image/png', file_size_bytes: imageBytes.length, is_public_approved: false,
    alt_text_public: 'Retained results chart.', image_content_kind: 'text_bearing',
    full_text_public: 'Retained accessible results: 94.2 percent.',
  }).select('id').single());

  const retainedPreviewIds: string[] = [];
  for (const project of retainedProjects) {
    const tokenHash = randomBytes(32).toString('hex');
    const generated = await rpc(client, 'generate_participant_preview', {
      p_public_id: project.publicId, p_admin_id: adminId, p_token_hash: tokenHash,
      p_expires_in_seconds: 3600, p_private_bucket: PRIVATE_BUCKET, p_is_correction_reissue: false,
    });
    assert.equal(generated.resultCode, 'SUCCESS');
    retainedPreviewIds.push(String(generated.previewId));
    assert.equal((await rpc(client, 'confirm_participant_preview', { p_token_hash: tokenHash })).resultCode, 'SUCCESS');
    assert.equal((await rpc(client, 'get_project_publication_readiness', {
      p_public_id: project.publicId, p_admin_id: adminId, p_private_bucket: PRIVATE_BUCKET,
    })).resultCode, 'READY');
  }

  const feedOperationId = randomUUID();
  const feedVersionId = randomUUID();
  const feedContent = JSON.stringify(retainedProjects.map((project, index) => ({
    id: 990001 + index,
    publicId: project.publicId,
    layoutConfig: project.layoutConfig,
  })));
  const feedHash = createHash('sha256').update(feedContent).digest('hex');
  const candidateMembers = JSON.stringify(retainedProjects.map((project, ordinal) => ({
    ordinal,
    publicId: project.publicId,
    recordHash: createHash('sha256').update(project.publicId).digest('hex'),
  })));
  const versionMemberValues = retainedProjects.map((project, ordinal) => (
    `(${sqlLiteral(feedVersionId)}::uuid,${ordinal},${sqlLiteral(project.publicId)},${sqlLiteral(createHash('sha256').update(project.publicId).digest('hex'))})`
  )).join(',');
  runDisposablePsql(identity, {
    singleTransaction: true,
    command: `
      INSERT INTO public.public_feed_operations(
        id,operation_key,kind,authorizing_actor_id,completion_actor_id,baseline_storage_existed,
        candidate_feed_hash,candidate_record_count,candidate_byte_count,candidate_feed_content,candidate_members,
        storage_bucket,storage_path,feed_public_url,media_manifest,rollback_capability_requested,state,
        owner_epoch,owner_token_hash,lease_expires_at,observed_storage_hash,observed_storage_record_count,
        created_at,updated_at,finalized_at,completed_at
      ) VALUES (
        ${sqlLiteral(feedOperationId)}::uuid,gen_random_uuid(),'activation',${sqlLiteral(adminId)}::uuid,${sqlLiteral(adminId)}::uuid,false,
        ${sqlLiteral(feedHash)},${retainedProjects.length},${Buffer.byteLength(feedContent)},${sqlLiteral(feedContent)},${sqlLiteral(candidateMembers)}::jsonb,
        'public-feeds','capstones-latest.json','https://assets.invalid/capstones-latest.json','[]'::jsonb,true,'COMPLETED',
        1,repeat('a',64),pg_catalog.now()+interval '1 hour',${sqlLiteral(feedHash)},${retainedProjects.length},
        pg_catalog.now(),pg_catalog.now(),pg_catalog.now(),pg_catalog.now()
      );
      INSERT INTO public.public_feed_versions(
        id,operation,operation_id,authorizing_actor_id,completion_actor_id,artifact_content,byte_count,feed_hash,record_count
      ) VALUES (
        ${sqlLiteral(feedVersionId)}::uuid,'baseline',${sqlLiteral(feedOperationId)}::uuid,${sqlLiteral(adminId)}::uuid,${sqlLiteral(adminId)}::uuid,
        ${sqlLiteral(feedContent)},${Buffer.byteLength(feedContent)},${sqlLiteral(feedHash)},${retainedProjects.length}
      );
      INSERT INTO public.public_feed_version_members(version_id,ordinal,public_id,record_hash)
        VALUES ${versionMemberValues};
      INSERT INTO public.public_feed_head(singleton,current_version_id,generation,activated_by_id,transitioned_by_id,last_operation_id)
        VALUES (true,${sqlLiteral(feedVersionId)}::uuid,1,${sqlLiteral(adminId)}::uuid,${sqlLiteral(adminId)}::uuid,${sqlLiteral(feedOperationId)}::uuid);
    `,
  });

  const baselineWithoutFingerprint = {
    adminId,
    retainedProjectIds: retainedProjects.map((project) => project.id),
    retainedPublicIds: retainedProjects.map((project) => project.publicId),
    retainedPreviewIds,
    feedOperationId, feedVersionId, feedContent,
  };
  const stateFingerprint = captureUpgradeState(identity, baselineWithoutFingerprint);
  console.log('PASS: seeded exact Migration 57 retained project/preview/media/feed/head/history/staff state');
  return { ...baselineWithoutFingerprint, stateFingerprint };
}

/** Verifies Migration 58 changed schema/authority only and preserved every representative row byte. */
export async function verifyLayoutRecipeUpgradePreservation(
  repositoryRoot: string,
  identity: DisposableStackIdentity,
  baseline: LayoutRecipeUpgradeBaseline,
): Promise<void> {
  assert.equal(runDisposablePsql(identity, {
    command: 'COPY (SELECT count(*) FROM supabase_migrations.schema_migrations) TO STDOUT;',
    singleTransaction: true,
  }).trim(), '58');
  assert.equal(runDisposablePsql(identity, {
    command: 'COPY (SELECT max(version) FROM supabase_migrations.schema_migrations) TO STDOUT;',
    singleTransaction: true,
  }).trim(), MIGRATION_58_VERSION);
  assert.equal(captureUpgradeState(identity, baseline), baseline.stateFingerprint);

  const env = readDisposableStackEnv(repositoryRoot, identity);
  const client = createClient(env.apiUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const previews = await requireData(client.from('participant_previews')
    .select('id, layout_config_snapshot').in('id', baseline.retainedPreviewIds));
  assert.equal(previews.length, baseline.retainedPreviewIds.length);
  assert(previews.every((preview) => preview.layout_config_snapshot === null));
  for (const publicId of baseline.retainedPublicIds) {
    assert.equal((await rpc(client, 'get_project_publication_readiness', {
      p_public_id: publicId, p_admin_id: baseline.adminId, p_private_bucket: PRIVATE_BUCKET,
    })).resultCode, 'READY');
  }
  assert.equal((await requireData(client.from('public_feed_versions')
    .select('artifact_content').eq('id', baseline.feedVersionId).single())).artifact_content, baseline.feedContent);
  assert.equal((await requireData(client.from('layout_recipe_versions').select('id'))).length, 0);
  assert.equal((await requireData(client.from('layout_recipe_audit_events').select('id'))).length, 0);
  console.log('PASS: exact 57 -> 58 upgrade preserved legacy/stock projects, staff, confirmed previews, media full text, feed/head/history and old readiness');
}

/** Synthetic-only proof against a verifier-owned, loopback disposable stack. */
export async function verifyLayoutRecipeRuntime(repositoryRoot: string, identity: DisposableStackIdentity): Promise<void> {
  assertDatabaseContainerOwned(identity);
  const env = readDisposableStackEnv(repositoryRoot, identity);
  assert.equal(new URL(env.apiUrl).hostname, '127.0.0.1');
  const firstSession = createClient(env.apiUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const secondSession = createClient(env.apiUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonymous = createClient(env.apiUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let phase = 'staff fixtures';
  try {
    const suffix = randomBytes(5).toString('hex');
    const adminId = await createStaff(firstSession, suffix, 'admin');
    const editorId = await createStaff(firstSession, suffix, 'editor');
  phase = 'migration inventory';
  const applied = runDisposablePsql(identity, {
    command: "COPY (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20260914100000') TO STDOUT;",
    singleTransaction: true,
  }).trim();
  assert.equal(applied, '1');
  assert.equal(await requireData(firstSession.rpc('get_release_capability_sentinel')), '20260918120000_governed_project_maintenance|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1|archived_project_republish_media_rearm_v1|governed_project_soft_delete_v1|governed_project_maintenance_v1');

  phase = 'authorization';
  const denied = await rpc(firstSession, 'create_layout_recipe', {
    p_actor_admin_id: editorId, p_name: 'Denied recipe', p_layout_config: configA, p_source_version_id: null,
  });
  assert.equal(denied.resultCode, 'PERMISSION_DENIED');
  assert.equal((await requireData(firstSession.from('layout_recipe_versions').select('id'))).length, 0);
  assert((await anonymous.from('layout_recipe_versions').select('id')).error);
  assert((await anonymous.rpc('create_layout_recipe', {
    p_actor_admin_id: adminId, p_name: 'Anonymous recipe', p_layout_config: configA, p_source_version_id: null,
  })).error);
  const serviceValidator = await firstSession.rpc('layout_recipe_config_valid', { p_config: configA });
  assert.equal(serviceValidator.error, null);
  assert.equal(serviceValidator.data, true);
  assert((await anonymous.rpc('layout_recipe_config_valid', { p_config: configA })).error);
  assert((await firstSession.rpc('layout_recipe_actor_can_manage', { p_actor_admin_id: adminId })).error);
  assert((await firstSession.rpc('get_project_publication_readiness_without_layout_recipe', {
    p_public_id: 'not-applicable', p_admin_id: adminId, p_private_bucket: 'project-drafts-private',
  })).error);
  assert((await firstSession.rpc('get_project_reconciliation_readiness_without_layout_recipe', {
    p_public_id: 'not-applicable', p_admin_id: adminId, p_private_bucket: 'project-drafts-private',
  })).error);
  console.log('PASS: database authorization and RLS reject editor/anonymous writes and internal RPC entry points');

  phase = 'validation';
  for (const [name, config] of [
    ['x'.repeat(121), configA],
    ['Control\nname', configA],
    ['Duplicate sections', { ...configA, sectionOrder: ['team', 'team'] }],
    ['Unknown section', { ...configA, sectionOrder: [...configA.sectionOrder.slice(0, 7), 'arbitraryHtml'] }],
    ['Hidden featured media', { ...configA, featuredMedia: 'video', hiddenSections: ['video'] }],
    ['Hidden snapshots', { ...configA, hiddenSections: ['snapshots'] }],
  ] as const) {
    const invalid = await rpc(firstSession, 'create_layout_recipe', {
      p_actor_admin_id: adminId, p_name: name, p_layout_config: config, p_source_version_id: null,
    });
    assert.equal(invalid.resultCode, 'VALIDATION_FAILED');
  }
  console.log('PASS: bounded names, enums, unique order and feature/visibility constraints fail closed, including hidden snapshots');

  phase = 'new stock workbook layouts';
  for (const [index, templateId] of LAYOUT_TEMPLATE_IDS.entries()) {
    const stockConfig = createLayoutConfigFromStock(templateId);
    const stockProjectId = randomUUID();
    const stockPublicId = `stock-xlsx-${templateId}-${suffix}`;
    await requireData(firstSession.from('projects').insert({
      id: stockProjectId, public_id: stockPublicId, title: `New stock XLSX ${templateId}`, summary: 'Summary',
      background: 'Background', solution: 'Solution', year: 2026, status: 'approved',
      team_members: ['Participant'], poster_text_public: 'Poster full text',
      accessibility_text_public: 'Poster description', layout_config: stockConfig,
    }).select('id').single());
    const stockTokenHash = randomBytes(32).toString('hex');
    const stockGenerated = await rpc(firstSession, 'generate_participant_preview', {
      p_public_id: stockPublicId, p_admin_id: adminId, p_token_hash: stockTokenHash,
      p_expires_in_seconds: 3600, p_private_bucket: PRIVATE_BUCKET, p_is_correction_reissue: false,
    });
    assert.equal(stockGenerated.resultCode, 'SUCCESS');
    const stockPreviewId = String(stockGenerated.previewId);
    assert.deepEqual((await requireData(secondSession.from('participant_previews')
      .select('layout_config_snapshot').eq('id', stockPreviewId).single())).layout_config_snapshot, stockConfig);
    assert.equal((await rpc(firstSession, 'confirm_participant_preview', { p_token_hash: stockTokenHash })).resultCode, 'SUCCESS');
    assert.equal((await rpc(firstSession, 'get_project_publication_readiness', {
      p_public_id: stockPublicId, p_admin_id: adminId, p_private_bucket: PRIVATE_BUCKET,
    })).resultCode, 'READY');
    const changedConfig = createLayoutConfigFromStock(LAYOUT_TEMPLATE_IDS[(index + 1) % LAYOUT_TEMPLATE_IDS.length]);
    await requireData(firstSession.from('projects').update({ layout_config: changedConfig })
      .eq('id', stockProjectId).select('id').single());
    assert.equal((await rpc(firstSession, 'get_project_publication_readiness', {
      p_public_id: stockPublicId, p_admin_id: adminId, p_private_bucket: PRIVATE_BUCKET,
    })).resultCode, 'PROJECT_SNAPSHOT_STALE');
    assert.deepEqual((await requireData(secondSession.from('participant_previews')
      .select('layout_config_snapshot').eq('id', stockPreviewId).single())).layout_config_snapshot, stockConfig);
  }
  console.log('PASS: all three new stock XLSX layouts capture exact non-null preview values, confirm READY and become stale after layout changes');

  phase = 'create reload duplicate';
  const created = await rpc(firstSession, 'create_layout_recipe', {
    p_actor_admin_id: adminId, p_name: 'Team-first showcase', p_layout_config: configA, p_source_version_id: null,
  });
  assert.equal(created.resultCode, 'CREATED');
  const firstVersionId = String(created.recipeVersionId);
  const reloaded = await requireData(secondSession.from('layout_recipe_versions')
    .select('id, recipe_id, version, name, layout_config, status').eq('id', firstVersionId).single());
  assert.deepEqual(reloaded.layout_config, configA);
  assert.equal(reloaded.status, 'active');

  const duplicated = await rpc(secondSession, 'create_layout_recipe', {
    p_actor_admin_id: adminId, p_name: 'Team-first duplicate', p_layout_config: null, p_source_version_id: firstVersionId,
  });
  assert.equal(duplicated.resultCode, 'DUPLICATED');
  const duplicateRow = await requireData(firstSession.from('layout_recipe_versions')
    .select('recipe_id, layout_config').eq('id', String(duplicated.recipeVersionId)).single());
  assert.notEqual(duplicateRow.recipe_id, reloaded.recipe_id);
  assert.deepEqual(duplicateRow.layout_config, configA);
  console.log('PASS: a second permitted session reloads and duplicates the persisted resolved value');

  phase = 'project value copy and lifecycle';
  const projectIds = [randomUUID(), randomUUID()];
  await requireData(firstSession.from('projects').insert(projectIds.map((id, index) => ({
    id, public_id: `layout-copy-${suffix}-${index + 1}`, title: `Layout copy ${index + 1}`,
    year: 2026, status: 'draft', team_members: ['Participant'], layout_config: configA,
  }))).select('id'));
  const projectConfigsBefore = await requireData(firstSession.from('projects')
    .select('id, layout_config').in('id', projectIds).order('id'));

  const previewProjectId = randomUUID();
  const previewPublicId = `layout-preview-${suffix}`;
  await requireData(firstSession.from('projects').insert({
    id: previewProjectId, public_id: previewPublicId, title: 'Layout preview', summary: 'Summary',
    background: 'Background', solution: 'Solution', year: 2026, status: 'approved',
    team_members: ['Participant'], poster_text_public: 'Poster full text',
    accessibility_text_public: 'Poster description', layout_config: configA,
  }).select('id'));
  const tokenHash = randomBytes(32).toString('hex');
  const generated = await rpc(firstSession, 'generate_participant_preview', {
    p_public_id: previewPublicId, p_admin_id: adminId, p_token_hash: tokenHash,
    p_expires_in_seconds: 3600, p_private_bucket: 'project-drafts-private', p_is_correction_reissue: false,
  });
  assert.equal(generated.resultCode, 'SUCCESS');
  const previewId = String(generated.previewId);
  const previewRow = await requireData(secondSession.from('participant_previews')
    .select('layout_config_snapshot').eq('id', previewId).single());
  assert.deepEqual(previewRow.layout_config_snapshot, configA);
  assert.equal((await rpc(firstSession, 'confirm_participant_preview', { p_token_hash: tokenHash })).resultCode, 'SUCCESS');
  assert.equal((await rpc(firstSession, 'get_project_publication_readiness', {
    p_public_id: previewPublicId, p_admin_id: adminId, p_private_bucket: 'project-drafts-private',
  })).resultCode, 'READY');

  const versioned = await rpc(firstSession, 'version_layout_recipe', {
    p_actor_admin_id: adminId, p_source_version_id: firstVersionId, p_expected_version: 1,
    p_name: 'Team-first showcase', p_layout_config: configB,
  });
  assert.equal(versioned.resultCode, 'VERSIONED');
  const secondVersionId = String(versioned.recipeVersionId);
  const conflict = await rpc(secondSession, 'version_layout_recipe', {
    p_actor_admin_id: adminId, p_source_version_id: firstVersionId, p_expected_version: 1,
    p_name: 'Stale write', p_layout_config: configB,
  });
  assert.equal(conflict.resultCode, 'VERSION_CONFLICT');
  const retired = await rpc(firstSession, 'retire_layout_recipe', {
    p_actor_admin_id: adminId, p_recipe_version_id: secondVersionId, p_expected_version: 2,
  });
  assert.equal(retired.resultCode, 'RETIRED');
  const versions = await requireData(firstSession.from('layout_recipe_versions')
    .select('id, version, status, layout_config').eq('recipe_id', reloaded.recipe_id).order('version'));
  assert.deepEqual(versions.map((row) => [row.version, row.status]), [[1, 'superseded'], [2, 'retired']]);
  assert.deepEqual(versions[0].layout_config, configA);
  assert.deepEqual(versions[1].layout_config, configB);
  assert.deepEqual(await requireData(firstSession.from('projects')
    .select('id, layout_config').in('id', projectIds).order('id')), projectConfigsBefore);
  assert.deepEqual((await requireData(secondSession.from('participant_previews')
    .select('layout_config_snapshot').eq('id', previewId).single())).layout_config_snapshot, configA);
  assert.equal((await rpc(firstSession, 'get_project_publication_readiness', {
    p_public_id: previewPublicId, p_admin_id: adminId, p_private_bucket: 'project-drafts-private',
  })).resultCode, 'READY');
  assert.equal((await requireData(firstSession.from('layout_recipe_audit_events')
    .select('action').eq('recipe_id', reloaded.recipe_id))).length, 3);
  console.log('PASS: version/race/retire are append-only and do not mutate copied projects or confirmed preview evidence');

  phase = 'participant snapshot and staleness';
  assert((await firstSession.from('participant_previews')
    .update({ layout_config_snapshot: configB }).eq('id', previewId)).error);
  await requireData(firstSession.from('projects').update({ layout_config: configB }).eq('id', previewProjectId).select('id'));
  const stale = await rpc(firstSession, 'get_project_publication_readiness', {
    p_public_id: previewPublicId, p_admin_id: adminId, p_private_bucket: 'project-drafts-private',
  });
  assert.equal(stale.resultCode, 'PROJECT_SNAPSHOT_STALE');
  assert.equal(stale.ready, false);
  assert.deepEqual((await requireData(secondSession.from('participant_previews')
    .select('layout_config_snapshot').eq('id', previewId).single())).layout_config_snapshot, configA);
  console.log('PASS: participant layout evidence is immutable and a changed project layout invalidates readiness');

  phase = 'historical participant preview compatibility';
  const historicalProjectId = randomUUID();
  const historicalPublicId = `historical-preview-${suffix}`;
  await requireData(firstSession.from('projects').insert({
    id: historicalProjectId, public_id: historicalPublicId, title: 'Historical preview', summary: 'Summary',
    background: 'Background', solution: 'Solution', year: 2026, status: 'approved',
    team_members: ['Participant'], poster_text_public: 'Poster full text',
    accessibility_text_public: 'Poster description', layout_config: {},
  }).select('id'));
  const historicalTokenHash = randomBytes(32).toString('hex');
  const historicalGenerated = await rpc(firstSession, 'generate_participant_preview', {
    p_public_id: historicalPublicId, p_admin_id: adminId, p_token_hash: historicalTokenHash,
    p_expires_in_seconds: 3600, p_private_bucket: 'project-drafts-private', p_is_correction_reissue: false,
  });
  assert.equal(historicalGenerated.resultCode, 'SUCCESS');
  assert.equal((await requireData(secondSession.from('participant_previews')
    .select('layout_config_snapshot').eq('id', String(historicalGenerated.previewId)).single()))
    .layout_config_snapshot, null);
  assert.equal((await rpc(firstSession, 'confirm_participant_preview', {
    p_token_hash: historicalTokenHash,
  })).resultCode, 'SUCCESS');
  assert.equal((await rpc(firstSession, 'get_project_publication_readiness', {
    p_public_id: historicalPublicId, p_admin_id: adminId, p_private_bucket: 'project-drafts-private',
  })).resultCode, 'READY');
  console.log('PASS: a historical project keeps a null layout snapshot and its established readiness behavior');

  phase = 'direct write boundary';
  const directInsert = await firstSession.from('layout_recipe_versions').insert({
    recipe_id: randomUUID(), version: 1, name: 'Bypass', layout_config: configA, created_by: adminId,
  });
  assert(directInsert.error);
  console.log('PASS: service-role writes remain confined to audited SECURITY DEFINER RPCs');
  } catch {
    throw new Error(`LAYOUT_RUNTIME_FAILED:${phase}`);
  }
}
