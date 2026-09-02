import path from 'node:path';
import { compareGate4Evidence, parseGate4Evidence, validateCurrentRepositoryGate4Contract } from '../deployment/gate4SchemaEvidence';
import { collectLocalGate4Evidence } from '../scripts/checkGate4SchemaEvidence';
import { repositoryMigrationVersions, type CaptureOptions } from './captureRecoveryBackup';
import {
  assertDatabaseContainerOwned,
  assertDisposableOwnership,
  runDisposablePsql,
  type DisposableStackIdentity,
} from './disposableSupabaseStack';
import { RecoveryGuardError } from './zeroCostRecoveryContract';

/**
 * Verifier-only, after migrations have established historical table ACLs and before ordinary
 * capture. No operator capture option invokes this fixture. A label or loopback URL alone cannot
 * authorize it: the capture and running database must belong to the same disposable identity.
 */
export function installSyntheticTableDefaultAclFixture(
  capture: Pick<CaptureOptions, 'repositoryRoot' | 'sourceKind' | 'target' | 'sourceProjectRef'>,
  identity: DisposableStackIdentity,
): unknown {
  if (capture.sourceKind !== 'disposable-local-synthetic' || capture.target.kind !== 'local') {
    throw new RecoveryGuardError('SYNTHETIC_TABLE_DEFAULT_ACL_PRECONDITION_FAILED');
  }
  if (path.resolve(capture.target.workdir) !== path.resolve(identity.workdir)
    || capture.sourceProjectRef !== identity.projectId) {
    throw new RecoveryGuardError('SYNTHETIC_TABLE_DEFAULT_ACL_SOURCE_NOT_OWNED');
  }
  try {
    assertDisposableOwnership(identity);
    assertDatabaseContainerOwned(identity);
  } catch {
    throw new RecoveryGuardError('SYNTHETIC_TABLE_DEFAULT_ACL_SOURCE_NOT_OWNED');
  }
  try {
    const before = collectLocalGate4Evidence(capture.repositoryRoot, identity.projectId);
    if (validateCurrentRepositoryGate4Contract(
      before, repositoryMigrationVersions(capture.repositoryRoot),
    ).length > 0) {
      throw new Error('SOURCE_SCHEMA_NOT_READY');
    }
    const parsed = parseGate4Evidence(before);
    if (!parsed.ok) throw new Error('SOURCE_EVIDENCE_INVALID');
    const expectedHighGrants = [
      'browser_import_commits', 'browser_import_media_commits', 'participant_previews',
      'participant_preview_confirmations', 'participant_preview_correction_requests',
    ].flatMap((table) => ['REFERENCES', 'TRIGGER', 'TRUNCATE']
      .map((privilege) => `public.${table}.service_role.${privilege}.false`)).sort();
    const actualHighGrants = parsed.evidence.tableGrants
      .filter((grant) => ['MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE'].includes(grant.privilege))
      .map((grant) => `${grant.schema}.${grant.table}.${grant.role}.${grant.privilege}.${grant.grantable}`).sort();
    if (JSON.stringify(actualHighGrants) !== JSON.stringify(expectedHighGrants)) {
      throw new Error('SOURCE_HIGH_IMPACT_GRANTS_UNEXPECTED');
    }
    runDisposablePsql(identity, {
      singleTransaction: true,
      command: `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLES
        TO anon, authenticated, service_role;`,
    });
    const defaults = runDisposablePsql(identity, {
      command: `COPY (SELECT count(*) FROM pg_catalog.pg_default_acl AS d
        CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS a
        JOIN pg_catalog.pg_roles AS r ON r.oid = a.grantee
        WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
          AND d.defaclobjtype = 'r' AND NOT a.is_grantable
          AND r.rolname IN ('anon', 'authenticated', 'service_role')
          AND a.privilege_type IN ('MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE')) TO STDOUT;`,
    });
    const after = collectLocalGate4Evidence(capture.repositoryRoot, identity.projectId);
    if (defaults.trim() !== '12'
      || compareGate4Evidence(before, after).classification !== 'GATE4_MATCH') {
      throw new Error('SOURCE_TABLE_ACLS_CHANGED');
    }
    return after;
  } catch {
    throw new RecoveryGuardError('SYNTHETIC_TABLE_DEFAULT_ACL_PROOF_FAILED');
  }
}
