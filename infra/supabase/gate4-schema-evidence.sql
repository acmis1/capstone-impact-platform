-- Gate 4 structural evidence collector.
--
-- This is one SELECT-only catalog query. It reads database structure, relevant
-- role privileges, migration versions, and canonical bucket configuration. It
-- never reads application rows, Auth identities, or Storage object metadata,
-- and it never invokes an application function.
WITH relevant_roles(role_name) AS (
  VALUES
    ('anon'::text),
    ('authenticated'::text),
    ('service_role'::text),
    ('capstone_assistive_dispatcher'::text)
),
relevant_schemas(schema_name) AS (
  VALUES ('public'::text), ('assistive_execution_control'::text)
),
role_rows AS (
  SELECT
    wanted.role_name AS name,
    roles.oid IS NOT NULL AS exists,
    COALESCE(roles.rolcanlogin, false) AS can_login,
    COALESCE(roles.rolinherit, false) AS inherits,
    COALESCE(roles.rolbypassrls, false) AS bypass_rls,
    COALESCE(roles.rolsuper, false) AS superuser
  FROM relevant_roles AS wanted
  LEFT JOIN pg_catalog.pg_roles AS roles ON roles.rolname = wanted.role_name
),
table_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS table_name,
    CASE relation.relkind
      WHEN 'r' THEN 'table'
      WHEN 'p' THEN 'partitioned_table'
    END AS relation_kind
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (SELECT schema_name FROM relevant_schemas)
    AND relation.relkind IN ('r', 'p')
),
rls_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS table_name,
    relation.relrowsecurity AS enabled,
    relation.relforcerowsecurity AS forced
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (SELECT schema_name FROM relevant_schemas)
    AND relation.relkind IN ('r', 'p')
),
column_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS table_name,
    attribute.attname AS column_name,
    attribute.attnum AS ordinal_position,
    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
    CASE
      WHEN data_type.typelem <> 0 AND data_type.typlen = -1
        THEN pg_catalog.format_type(data_type.typelem, NULL)
      ELSE NULL
    END AS array_element_type,
    NOT attribute.attnotnull AS nullable,
    attribute.attidentity::text AS identity_behavior,
    attribute.attgenerated::text AS generated_behavior,
    CASE
      WHEN attribute.atthasdef
        THEN pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, false)
      ELSE NULL
    END AS default_expression
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_type AS data_type ON data_type.oid = attribute.atttypid
  LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
    ON attribute_default.adrelid = attribute.attrelid
   AND attribute_default.adnum = attribute.attnum
  WHERE namespace.nspname IN (SELECT schema_name FROM relevant_schemas)
    AND relation.relkind IN ('r', 'p')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
),
constraint_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS table_name,
    constraint_definition.conname AS constraint_name,
    CASE constraint_definition.contype
      WHEN 'p' THEN 'primary_key'
      WHEN 'u' THEN 'unique'
      WHEN 'f' THEN 'foreign_key'
      WHEN 'c' THEN 'check'
    END AS constraint_type,
    pg_catalog.pg_get_constraintdef(constraint_definition.oid, false) AS definition,
    constraint_definition.condeferrable AS deferrable,
    constraint_definition.condeferred AS initially_deferred,
    constraint_definition.convalidated AS validated
  FROM pg_catalog.pg_constraint AS constraint_definition
  JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_definition.conrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (SELECT schema_name FROM relevant_schemas)
    AND relation.relkind IN ('r', 'p')
    AND constraint_definition.contype IN ('p', 'u', 'f', 'c')
),
policy_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS table_name,
    policy.polname AS policy_name,
    policy.polpermissive AS permissive,
    CASE policy.polcmd
      WHEN '*' THEN 'all'
      WHEN 'r' THEN 'select'
      WHEN 'a' THEN 'insert'
      WHEN 'w' THEN 'update'
      WHEN 'd' THEN 'delete'
    END AS command,
    ARRAY(
      SELECT COALESCE(role_definition.rolname, 'public')
      FROM pg_catalog.unnest(policy.polroles) AS policy_role(role_oid)
      LEFT JOIN pg_catalog.pg_roles AS role_definition ON role_definition.oid = policy_role.role_oid
      ORDER BY COALESCE(role_definition.rolname, 'public')
    ) AS roles,
    pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) AS using_expression,
    pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) AS with_check_expression
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN (SELECT schema_name FROM relevant_schemas)
    AND relation.relkind IN ('r', 'p')
),
table_grant_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS table_name,
    COALESCE(grantee_role.rolname, 'public') AS role_name,
    table_acl.privilege_type,
    table_acl.is_grantable
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
  ) AS table_acl
  LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = table_acl.grantee
  WHERE namespace.nspname IN (SELECT schema_name FROM relevant_schemas)
    AND relation.relkind IN ('r', 'p')
    AND COALESCE(grantee_role.rolname, 'public') IN (
      'public', 'anon', 'authenticated', 'service_role', 'capstone_assistive_dispatcher'
    )
),
schema_grant_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    COALESCE(grantee_role.rolname, 'public') AS role_name,
    schema_acl.privilege_type,
    schema_acl.is_grantable
  FROM pg_catalog.pg_namespace AS namespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
  ) AS schema_acl
  LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = schema_acl.grantee
  WHERE namespace.nspname IN (SELECT schema_name FROM relevant_schemas)
    AND COALESCE(grantee_role.rolname, 'public') IN (
      'public', 'anon', 'authenticated', 'service_role', 'capstone_assistive_dispatcher'
    )
),
routine_base AS (
  SELECT
    routine.oid,
    namespace.nspname AS schema_name,
    routine.proname AS routine_name,
    CASE routine.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS routine_kind,
    ARRAY(
      SELECT COALESCE(routine.proargnames[position], '')
      FROM pg_catalog.generate_series(1, routine.pronargs) AS argument(position)
      ORDER BY position
    ) AS argument_names,
    ARRAY(
      SELECT pg_catalog.format_type(routine.proargtypes[position - 1], NULL)
      FROM pg_catalog.generate_series(1, routine.pronargs) AS argument(position)
      ORDER BY position
    ) AS argument_types,
    pg_catalog.pg_get_function_result(routine.oid) AS return_type,
    routine.prosecdef AS security_definer,
    COALESCE(routine.proconfig, ARRAY[]::text[]) AS configuration,
    COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'role', COALESCE(grantee_role.rolname, 'public'),
          'grantable', routine_acl.is_grantable
        )
        ORDER BY COALESCE(grantee_role.rolname, 'public')
      )
      FROM pg_catalog.aclexplode(
        COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
      ) AS routine_acl
      LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = routine_acl.grantee
      WHERE routine_acl.privilege_type = 'EXECUTE'
        AND COALESCE(grantee_role.rolname, 'public') IN (
          'public', 'anon', 'authenticated', 'service_role', 'capstone_assistive_dispatcher'
        )
    ), '[]'::jsonb) AS execute_grants
  FROM pg_catalog.pg_proc AS routine
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
  WHERE namespace.nspname IN (SELECT schema_name FROM relevant_schemas)
    AND routine.prokind IN ('f', 'p')
    AND (
      (namespace.nspname = 'public' AND routine.proname = 'canonical_staff_roles')
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) AS relevant_acl
        LEFT JOIN pg_catalog.pg_roles AS relevant_grantee ON relevant_grantee.oid = relevant_acl.grantee
        WHERE relevant_acl.privilege_type = 'EXECUTE'
          AND COALESCE(relevant_grantee.rolname, 'public') IN (
            'public', 'anon', 'authenticated', 'service_role', 'capstone_assistive_dispatcher'
          )
      )
    )
),
routine_rows AS (
  SELECT
    routine_base.*,
    CASE
      WHEN schema_name = 'assistive_execution_control' THEN 'dispatcher_control'
      WHEN routine_name = 'canonical_staff_roles' THEN 'canonical_helper'
      WHEN execute_grants @> '[{"role":"service_role"}]'::jsonb THEN 'application_rpc'
      ELSE 'other_exposed_routine'
    END AS classification
  FROM routine_base
),
bucket_rows AS (
  SELECT
    bucket.id,
    bucket.name,
    bucket.public,
    bucket.file_size_limit,
    bucket.allowed_mime_types
  FROM storage.buckets AS bucket
),
migration_rows AS (
  SELECT migration.version::text AS version
  FROM supabase_migrations.schema_migrations AS migration
)
SELECT pg_catalog.jsonb_build_object(
  'formatVersion', 'gate4-schema-evidence/v1',
  'roles', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', role_rows.name,
      'exists', role_rows.exists,
      'canLogin', role_rows.can_login,
      'inherits', role_rows.inherits,
      'bypassRls', role_rows.bypass_rls,
      'superuser', role_rows.superuser
    ) ORDER BY role_rows.name)
    FROM role_rows
  ), '[]'::jsonb),
  'migrations', COALESCE((
    SELECT pg_catalog.jsonb_agg(migration_rows.version ORDER BY migration_rows.version)
    FROM migration_rows
  ), '[]'::jsonb),
  'tables', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', table_rows.schema_name,
      'name', table_rows.table_name,
      'kind', table_rows.relation_kind
    ) ORDER BY table_rows.schema_name, table_rows.table_name)
    FROM table_rows
  ), '[]'::jsonb),
  'columns', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', column_rows.schema_name,
      'table', column_rows.table_name,
      'name', column_rows.column_name,
      'ordinal', column_rows.ordinal_position,
      'dataType', column_rows.data_type,
      'arrayElementType', column_rows.array_element_type,
      'nullable', column_rows.nullable,
      'identity', column_rows.identity_behavior,
      'generated', column_rows.generated_behavior,
      'defaultExpression', column_rows.default_expression
    ) ORDER BY column_rows.schema_name, column_rows.table_name, column_rows.ordinal_position)
    FROM column_rows
  ), '[]'::jsonb),
  'constraints', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', constraint_rows.schema_name,
      'table', constraint_rows.table_name,
      'name', constraint_rows.constraint_name,
      'type', constraint_rows.constraint_type,
      'definition', constraint_rows.definition,
      'deferrable', constraint_rows.deferrable,
      'initiallyDeferred', constraint_rows.initially_deferred,
      'validated', constraint_rows.validated
    ) ORDER BY constraint_rows.schema_name, constraint_rows.table_name, constraint_rows.constraint_name)
    FROM constraint_rows
  ), '[]'::jsonb),
  'rls', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', rls_rows.schema_name,
      'table', rls_rows.table_name,
      'enabled', rls_rows.enabled,
      'forced', rls_rows.forced
    ) ORDER BY rls_rows.schema_name, rls_rows.table_name)
    FROM rls_rows
  ), '[]'::jsonb),
  'policies', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', policy_rows.schema_name,
      'table', policy_rows.table_name,
      'name', policy_rows.policy_name,
      'permissive', policy_rows.permissive,
      'command', policy_rows.command,
      'roles', policy_rows.roles,
      'usingExpression', policy_rows.using_expression,
      'withCheckExpression', policy_rows.with_check_expression
    ) ORDER BY policy_rows.schema_name, policy_rows.table_name, policy_rows.policy_name)
    FROM policy_rows
  ), '[]'::jsonb),
  'tableGrants', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', table_grant_rows.schema_name,
      'table', table_grant_rows.table_name,
      'role', table_grant_rows.role_name,
      'privilege', table_grant_rows.privilege_type,
      'grantable', table_grant_rows.is_grantable
    ) ORDER BY table_grant_rows.schema_name, table_grant_rows.table_name, table_grant_rows.role_name, table_grant_rows.privilege_type)
    FROM table_grant_rows
  ), '[]'::jsonb),
  'schemaGrants', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', schema_grant_rows.schema_name,
      'role', schema_grant_rows.role_name,
      'privilege', schema_grant_rows.privilege_type,
      'grantable', schema_grant_rows.is_grantable
    ) ORDER BY schema_grant_rows.schema_name, schema_grant_rows.role_name, schema_grant_rows.privilege_type)
    FROM schema_grant_rows
  ), '[]'::jsonb),
  'functions', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'schema', routine_rows.schema_name,
      'name', routine_rows.routine_name,
      'kind', routine_rows.routine_kind,
      'argumentNames', routine_rows.argument_names,
      'argumentTypes', routine_rows.argument_types,
      'returnType', routine_rows.return_type,
      'securityDefiner', routine_rows.security_definer,
      'configuration', routine_rows.configuration,
      'executeGrants', routine_rows.execute_grants,
      'classification', routine_rows.classification
    ) ORDER BY routine_rows.schema_name, routine_rows.routine_name, routine_rows.argument_types)
    FROM routine_rows
  ), '[]'::jsonb),
  'storageBuckets', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', bucket_rows.id,
      'name', bucket_rows.name,
      'public', bucket_rows.public,
      'fileSizeLimit', bucket_rows.file_size_limit,
      'allowedMimeTypes', bucket_rows.allowed_mime_types
    ) ORDER BY bucket_rows.id)
    FROM bucket_rows
  ), '[]'::jsonb)
) AS gate4_evidence;
