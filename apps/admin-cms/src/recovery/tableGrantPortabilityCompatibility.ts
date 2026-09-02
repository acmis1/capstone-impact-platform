import {
  parseGate4Evidence,
  validateCurrentRepositoryGate4Contract,
  type Gate4TableGrantEvidence,
} from '../deployment/gate4SchemaEvidence';
import { ALL_REQUIRED_TABLES } from '../deployment/hostedDeploymentReadiness';
import { RecoveryGuardError } from './zeroCostRecoveryContract';

const APPROVED_ROLES = new Set(['anon', 'authenticated', 'service_role']);
const APPROVED_PRIVILEGES = new Set(['MAINTAIN', 'REFERENCES', 'TRIGGER', 'TRUNCATE']);
const APPLICATION_TABLES = new Set<string>(ALL_REQUIRED_TABLES);

export interface TableGrantPortabilityPlan {
  action: 'MATCH' | 'REVOKED_KNOWN_TARGET_DEFAULT_ACL_OVERGRANTS';
  revokeCount: number;
  sql: string | null;
}

function fail(reason: string): never {
  // Never surface parser errors, catalog values, or executable statements.
  throw new RecoveryGuardError(`TABLE_GRANT_PORTABILITY_COMPATIBILITY_${reason}`);
}

function grantKey(grant: Gate4TableGrantEvidence): string {
  return JSON.stringify([grant.schema, grant.table, grant.role, grant.privilege]);
}

/**
 * Recovery-only subtraction of fresh-table default ACL overgrants. The source is checksum-bound
 * by the bundle loader; its structural/repository contract is also required here. Plan the entire
 * matrix before executing anything: missing grants and unclassified extras never cause a GRANT.
 * The target has no migration rows or buckets yet, so only its parsed table inventory is compared
 * at this stage. The complete target repository contract remains mandatory at final Gate 4.
 */
export function planTableGrantPortabilityCompatibility(
  sourceInput: unknown,
  targetInput: unknown,
  repositoryMigrations: readonly string[],
): TableGrantPortabilityPlan {
  const source = parseGate4Evidence(sourceInput);
  if (!source.ok
    || validateCurrentRepositoryGate4Contract(sourceInput, repositoryMigrations).length > 0) {
    fail('SOURCE_EVIDENCE_INVALID');
  }
  const target = parseGate4Evidence(targetInput);
  if (!target.ok) fail('TARGET_EVIDENCE_INVALID');

  const inventory = (tables: typeof source.evidence.tables) => tables
    .map((table) => JSON.stringify([table.schema, table.name, table.kind])).sort();
  if (JSON.stringify(inventory(source.evidence.tables))
    !== JSON.stringify(inventory(target.evidence.tables))) {
    fail('TABLE_INVENTORY_MISMATCH');
  }
  const sourceTables = new Set(source.evidence.tables
    .filter((table) => table.schema === 'public').map((table) => table.name));
  for (const grant of [...source.evidence.tableGrants, ...target.evidence.tableGrants]) {
    if (grant.schema !== 'public'
      || !APPLICATION_TABLES.has(grant.table)
      || !sourceTables.has(grant.table)
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(grant.table)) {
      fail('TABLE_OUTSIDE_INVENTORY');
    }
  }

  const sourceGrants = new Map(source.evidence.tableGrants.map((grant) => [grantKey(grant), grant]));
  const targetGrants = new Map(target.evidence.tableGrants.map((grant) => [grantKey(grant), grant]));
  for (const [key, grant] of sourceGrants) {
    const restored = targetGrants.get(key);
    if (!restored || restored.grantable !== grant.grantable) fail('SOURCE_REQUIRED_GRANT_MISMATCH');
  }
  const extras = target.evidence.tableGrants.filter((grant) => !sourceGrants.has(grantKey(grant)));
  if (extras.some((grant) => grant.grantable
    || !APPROVED_ROLES.has(grant.role)
    || !APPROVED_PRIVILEGES.has(grant.privilege))) {
    fail('UNCLASSIFIED_TARGET_EXTRA');
  }
  if (extras.length === 0) return { action: 'MATCH', revokeCount: 0, sql: null };

  // All interpolated tokens have passed fixed allowlists and identifier validation. Quoting is
  // explicit; no source SQL, grant option, CASCADE, or provider/global operation is replayed here.
  const sql = extras.sort((left, right) => grantKey(left).localeCompare(grantKey(right)))
    .map((grant) => `REVOKE ${grant.privilege} ON TABLE "public"."${grant.table}" FROM "${grant.role}";`)
    .join('\n');
  return { action: 'REVOKED_KNOWN_TARGET_DEFAULT_ACL_OVERGRANTS', revokeCount: extras.length, sql };
}
