import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ALL_REQUIRED_TABLES,
  EXPECTED_REPOSITORY_MIGRATIONS,
  EXPECTED_REPOSITORY_MIGRATION_COUNT,
  REQUIRED_CORE_TABLES,
  REQUIRED_RPC_NAMES,
  REQUIRED_RPC_SIGNATURES,
  REQUIRED_STORAGE_BUCKETS,
  checkHostedDeploymentReadinessWithClient,
  evaluateHostedDeploymentReadiness,
  fetchPostgrestOpenApi,
  formatHostedReadinessReport,
  inspectPostgrestOpenApi,
  type HostedReadinessClient,
  type HostedReadinessEvidence,
  type QueryBuilder,
  type RequiredRpcSignature,
} from './hostedDeploymentReadiness';
import { getOptionalGeminiEnv } from '../lib/env';
import { isParticipantPreviewEmailEnabled } from '../notifications/participantPreviewEmailConfig';
import { isParticipantPreviewRemindersEnabled } from '../reminders/participantPreviewReminderConfig';
import { isStaffProvisioningEnabled } from '../staff/staffProvisioningEnablement';

const repoRoot = path.resolve(__dirname, '../../../..');
const migrationsDir = path.resolve(repoRoot, 'infra/supabase/migrations');

function migrationSources(): Array<{ file: string; source: string }> {
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, source: fs.readFileSync(path.resolve(migrationsDir, file), 'utf8') }));
}

function normalizeType(type: string): string {
  return type.toLowerCase().replace(/\s+/g, '');
}

function splitParameters(raw: string): string[] {
  return raw
    .split(',')
    .map((parameter) => parameter.trim())
    .filter(Boolean);
}

function parseCreatedSignature(name: string, rawParameters: string): RequiredRpcSignature {
  const parameters = splitParameters(rawParameters).map((parameter) => parameter.replace(/\s+DEFAULT\s+.*$/i, '').trim());
  return {
    name,
    parameterNames: parameters.map((parameter) => parameter.match(/^([a-z0-9_]+)\s+/i)?.[1] ?? ''),
    parameterTypes: parameters.map((parameter) => normalizeType(parameter.replace(/^[a-z0-9_]+\s+/i, ''))),
  };
}

function typedSignatureKey(name: string, parameterTypes: readonly string[]): string {
  return `${name}(${parameterTypes.map(normalizeType).join(',')})`;
}

function migrationServiceRoleContracts(): {
  application: RequiredRpcSignature[];
  internal: RequiredRpcSignature[];
} {
  const definitions = new Map<string, RequiredRpcSignature>();
  const granted = new Set<string>();
  const eventPattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*RETURNS|GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s+TO\s+service_role|DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)/gi;

  for (const { source } of migrationSources()) {
    for (const match of source.matchAll(eventPattern)) {
      if (match[1]) {
        const signature = parseCreatedSignature(match[1], match[2]);
        definitions.set(typedSignatureKey(signature.name, signature.parameterTypes), signature);
      } else if (match[3]) {
        granted.add(typedSignatureKey(match[3], splitParameters(match[4])));
      } else if (match[5]) {
        const key = typedSignatureKey(match[5], splitParameters(match[6]));
        granted.delete(key);
        definitions.delete(key);
      }
    }
  }

  const finalGranted = [...granted].map((key) => {
    const signature = definitions.get(key);
    if (!signature) throw new Error(`Missing CREATE FUNCTION definition for ${key}`);
    return signature;
  });
  return {
    application: finalGranted.filter((signature) => signature.name !== 'canonical_staff_roles'),
    internal: finalGranted.filter((signature) => signature.name === 'canonical_staff_roles'),
  };
}

function contractKey(signature: RequiredRpcSignature): string {
  return `${typedSignatureKey(signature.name, signature.parameterTypes)}:${signature.parameterNames.join(',')}`;
}

function openApiDocument(signatures: readonly RequiredRpcSignature[] = REQUIRED_RPC_SIGNATURES): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const table of ALL_REQUIRED_TABLES) paths[`/${table}`] = { get: {} };
  for (const signature of signatures) {
    paths[`/rpc/${signature.name}`] = {
      post: {
        parameters: [
          {
            name: 'args',
            in: 'body',
            schema: {
              type: 'object',
              properties: Object.fromEntries(
                signature.parameterNames.map((name, index) => [name, { format: signature.parameterTypes[index] }])
              ),
            },
          },
        ],
      },
    };
  }
  return { swagger: '2.0', paths };
}

function completeEvidence(overrides: Partial<HostedReadinessEvidence> = {}): HostedReadinessEvidence {
  return {
    targetIdentityMatch: true,
    migrationHistoryReadable: true,
    recordedMigrationVersions: EXPECTED_REPOSITORY_MIGRATIONS.map((migration) => migration.split('_')[0]),
    presentTables: [...ALL_REQUIRED_TABLES],
    rpcMetadataReadable: true,
    presentRpcNames: [...REQUIRED_RPC_NAMES],
    presentRpcSignatures: [...REQUIRED_RPC_SIGNATURES],
    relationMetadataReadable: true,
    publicRelations: [...ALL_REQUIRED_TABLES],
    storageEvidenceReadable: true,
    presentBuckets: [...REQUIRED_STORAGE_BUCKETS],
    authUserIdColumnPresent: true,
    initialAdminLinkagePresent: true,
    recognizedRolesPresent: true,
    manualEvidence: {
      migrationHistoryMatches: true,
      exactSchemaObjectsMatch: true,
      exactConstraintsMatch: true,
      exactGrantsMatch: true,
      exactRpcSignaturesMatch: true,
    },
    ...overrides,
  };
}

describe('Hosted Deployment Readiness & Staging Governance Contract Tests', () => {
  describe('authoritative migration, table, and RPC inventory', () => {
    it('matches the exact 32 migration files and keeps every historical file byte-identical to origin/main', () => {
      const files = migrationSources().map(({ file }) => file);
      expect(EXPECTED_REPOSITORY_MIGRATION_COUNT).toBe(32);
      expect(files).toEqual([...EXPECTED_REPOSITORY_MIGRATIONS]);

      expect(() => execFileSync(
        'git',
        ['diff', '--exit-code', 'origin/main', '--', ...EXPECTED_REPOSITORY_MIGRATIONS.slice(0, -1).map(
          (historical) => `infra/supabase/migrations/${historical}`,
        )],
        { cwd: repoRoot, stdio: 'pipe' },
      )).not.toThrow();
    });

    it('matches exact application CREATE TABLE definitions rather than a count alone', () => {
      const createdTables = migrationSources().flatMap(({ source }) =>
        [...source.matchAll(/^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?([a-z0-9_]+)/gim)].map(
          (match) => match[1]
        )
      );

      expect([...ALL_REQUIRED_TABLES].sort()).toEqual([...new Set(createdTables)].sort());
      expect(ALL_REQUIRED_TABLES).toHaveLength(27);
      expect(ALL_REQUIRED_TABLES).toContain('assistive_validation_runs');
      expect(ALL_REQUIRED_TABLES).toContain('assistive_validation_findings');
      expect(ALL_REQUIRED_TABLES).toContain('assistive_validation_jobs');
      expect(ALL_REQUIRED_TABLES).toContain('publication_attempts');
      expect(ALL_REQUIRED_TABLES).toContain('public_removal_attempts');
      expect(ALL_REQUIRED_TABLES).not.toContain('participant_preview_tokens');
      expect(ALL_REQUIRED_TABLES).toContain('password_recovery_sessions');
    });

    it('matches every final service-role application RPC signature and isolates the one internal helper', () => {
      const contracts = migrationServiceRoleContracts();
      expect(contracts.application.map(contractKey).sort()).toEqual(REQUIRED_RPC_SIGNATURES.map(contractKey).sort());
      expect(contracts.application).toHaveLength(58);
      expect(REQUIRED_RPC_NAMES).toContain('persist_assistive_validation_run');
      expect(REQUIRED_RPC_NAMES).toContain('record_assistive_finding_disposition');
      expect(REQUIRED_RPC_NAMES).toContain('claim_next_assistive_validation_job');
      expect(contracts.internal.map(contractKey)).toEqual(['canonical_staff_roles(text[]):p_roles']);
      expect(REQUIRED_RPC_NAMES).not.toContain('execute_controlled_publication');
      expect(REQUIRED_RPC_NAMES).not.toContain('execute_controlled_public_removal');
      expect(REQUIRED_RPC_NAMES).not.toContain('resolve_participant_preview_correction_request');
    });
  });

  describe('evidence-based classifications', () => {
    it('allows READY only when automated and explicit Gate 3/4 evidence are complete', () => {
      const result = evaluateHostedDeploymentReadiness(completeEvidence());
      expect(result.schemaBaseline).toBe('MATCH');
      expect(result.deploymentClassification).toBe('READY_FOR_MUTATION_DECISION');
      expect(result.manualEvidenceRequired).toBe(false);
    });

    it('stops at MANUAL_EVIDENCE_REQUIRED when expected automated evidence is present', () => {
      const result = evaluateHostedDeploymentReadiness(completeEvidence({ manualEvidence: undefined }));
      expect(result.schemaBaseline).toBe('UNVERIFIED');
      expect(result.deploymentClassification).toBe('MANUAL_EVIDENCE_REQUIRED');
      expect(result.manualEvidenceRequired).toBe(true);
    });

    it('keeps the privilege-hidden recovery ledger manual without classifying it as missing', () => {
      const result = evaluateHostedDeploymentReadiness(completeEvidence({
        presentTables: ALL_REQUIRED_TABLES.filter(
          (table) => table !== 'password_recovery_sessions',
        ),
        unverifiedTables: ['password_recovery_sessions'],
        manualEvidence: undefined,
      }));
      expect(result.requiredTableSet).toBe('UNVERIFIED');
      expect(result.missingTables).toEqual([]);
      expect(result.unverifiedTables).toEqual(['password_recovery_sessions']);
      expect(result.deploymentClassification).toBe('MANUAL_EVIDENCE_REQUIRED');
    });

    it('classifies proven missing objects or migration versions as RECONCILIATION_REQUIRED', () => {
      const missingTable = evaluateHostedDeploymentReadiness(
        completeEvidence({ presentTables: [...REQUIRED_CORE_TABLES], manualEvidence: undefined })
      );
      expect(missingTable.requiredTableSet).toBe('INCOMPLETE');
      expect(missingTable.deploymentClassification).toBe('RECONCILIATION_REQUIRED');

      const missingMigration = evaluateHostedDeploymentReadiness(
        completeEvidence({ recordedMigrationVersions: [], manualEvidence: undefined })
      );
      expect(missingMigration.missingMigrations).toHaveLength(32);
      expect(missingMigration.deploymentClassification).toBe('RECONCILIATION_REQUIRED');
    });

    it('classifies OpenAPI-visible unexpected public relations as DRIFT_REQUIRES_REVIEW', () => {
      const result = evaluateHostedDeploymentReadiness(
        completeEvidence({ publicRelations: [...ALL_REQUIRED_TABLES, 'unexpected_relation'], manualEvidence: undefined })
      );
      expect(result.unexpectedPublicRelations).toEqual(['unexpected_relation']);
      expect(result.deploymentClassification).toBe('DRIFT_REQUIRES_REVIEW');
    });

    it('classifies explicit Gate 4 mismatch as drift and Gate 3 mismatch as reconciliation', () => {
      const schemaDrift = evaluateHostedDeploymentReadiness(
        completeEvidence({
          manualEvidence: {
            ...completeEvidence().manualEvidence!,
            exactGrantsMatch: false,
          },
        })
      );
      expect(schemaDrift.deploymentClassification).toBe('DRIFT_REQUIRES_REVIEW');
      expect(schemaDrift.manualEvidenceRequired).toBe(false);

      const migrationMismatch = evaluateHostedDeploymentReadiness(
        completeEvidence({
          manualEvidence: {
            ...completeEvidence().manualEvidence!,
            migrationHistoryMatches: false,
          },
        })
      );
      expect(migrationMismatch.deploymentClassification).toBe('RECONCILIATION_REQUIRED');
    });

    it('blocks before inspection when the target identity guard fails', () => {
      const result = evaluateHostedDeploymentReadiness(completeEvidence({ targetIdentityMatch: false }));
      expect(result.deploymentClassification).toBe('BLOCKED');
      expect(result.missingTables).toEqual([]);
    });

    it('blocks without claiming missing objects when inspection cannot initialize', () => {
      const result = evaluateHostedDeploymentReadiness(
        completeEvidence({ inspectionBlocked: true, manualEvidence: undefined })
      );
      expect(result.targetIdentityMatch).toBe(true);
      expect(result.deploymentClassification).toBe('BLOCKED');
      expect(result.missingTables).toEqual([]);
    });
  });

  describe('OpenAPI-only RPC metadata and zero-mutation inspection', () => {
    it('fetches only the PostgREST root with GET and never an RPC route', async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response(JSON.stringify(openApiDocument()), {
          status: 200,
          headers: { 'Content-Type': 'application/openapi+json' },
        });
      });

      await fetchPostgrestOpenApi('https://example.supabase.co', 'redacted-test-key', fetchMock);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://example.supabase.co/rest/v1/');
      expect(init?.method).toBe('GET');
      expect(String(url)).not.toContain('/rpc/');
      expect(init?.body).toBeUndefined();
    });

    it('extracts public relation names and exact metadata signatures without executing them', () => {
      const inspected = inspectPostgrestOpenApi(openApiDocument());
      expect(inspected?.publicRelations).toEqual([...ALL_REQUIRED_TABLES].sort());
      expect(inspected?.rpcNames).toEqual([...REQUIRED_RPC_NAMES].sort());
      expect(inspected?.rpcSignatures).toHaveLength(57);
      expect(inspected?.rpcSignatures.some((signature) => signature.name === 'execute_controlled_publication')).toBe(false);
    });

    it('uses only zero-row HEAD reads, aggregate auth evidence, and read-only bucket listing', async () => {
      const calls: Array<{ table: string; columns: string; options?: { head?: boolean; count?: 'exact' }; filter?: string; limit?: number }> = [];

      const mockClient: HostedReadinessClient = {
        from: (table) => ({
          select: (columns, options) => {
            const call = { table, columns, options } as (typeof calls)[number];
            calls.push(call);
            const responseValue: { data: null; error: null; count?: number } = { data: null, error: null };
            const response = Promise.resolve(responseValue);
            const builder = Object.assign(response, {
              limit(count: number) {
                call.limit = count;
                return builder;
              },
              not(column: string, operator: string) {
                call.filter = `${column}.${operator}`;
                responseValue.count = 1;
                return builder;
              },
              eq(column: string, value: unknown) {
                call.filter = `${column}.eq.${String(value)}`;
                responseValue.count = 1;
                return builder;
              },
            }) as QueryBuilder;
            return builder;
          },
        }),
        storage: {
          listBuckets: vi.fn(async () => ({
            data: REQUIRED_STORAGE_BUCKETS.map((id) => ({ id, name: id })),
            error: null,
          })),
        },
      };

      const result = await checkHostedDeploymentReadinessWithClient(mockClient, {
        openApiDocument: openApiDocument(),
      });

      expect(result.requiredTableSet).toBe('PRESENT');
      expect(result.requiredRpcNames).toBe('PRESENT');
      expect(result.requiredRpcSignatures).toBe('UNVERIFIED');
      expect(result.requiredStorageBuckets).toBe('PRESENT');
      expect(result.authFoundation).toBe('READY');
      expect(result.migrationHistoryReadable).toBe(false);
      expect(result.hostedRecordedMigrations).toBe('UNKNOWN');
      expect(result.deploymentClassification).toBe('MANUAL_EVIDENCE_REQUIRED');
      expect(calls.every((call) => call.options?.head === true)).toBe(true);
      expect(calls.filter((call) => !call.filter).every((call) => call.columns === '*' && call.limit === 0)).toBe(true);
      expect(calls.filter((call) => call.filter).every((call) => call.columns === 'id')).toBe(true);
      expect(calls.find((call) => call.table === 'admin_users' && call.filter)?.limit).toBe(1);
      expect(calls.find((call) => call.table === 'user_roles' && call.filter)?.limit).toBe(1);
      expect(calls.some((call) => call.table === 'schema_migrations')).toBe(false);
      expect('rpc' in mockClient).toBe(false);
    });

    it('permanently rejects RPC execution and POST-based discovery in production source', () => {
      const source = fs.readFileSync(path.resolve(__dirname, 'hostedDeploymentReadiness.ts'), 'utf8');
      expect(source).not.toMatch(/\.rpc\s*\(/);
      expect(source).not.toMatch(/method\s*:\s*['"]POST['"]/);
      expect(source).not.toMatch(/fetch\s*\([^)]*\/rpc\//);
      expect(source).not.toContain("schema('supabase_migrations')");
      expect(source).not.toContain("from('schema_migrations')");
    });
  });

  describe('safe output and fail-closed optional configuration', () => {
    it('reports evidence states without secrets or identifying data', () => {
      const report = formatHostedReadinessReport(
        evaluateHostedDeploymentReadiness(completeEvidence({ manualEvidence: undefined, migrationHistoryReadable: false, recordedMigrationVersions: [] }))
      );
      expect(report).toContain('MIGRATION_HISTORY_READABLE = NO');
      expect(report).toContain('HOSTED_RECORDED_MIGRATIONS = UNKNOWN');
      expect(report).toContain('SCHEMA_BASELINE = UNVERIFIED');
      expect(report).toContain('MANUAL_EVIDENCE_REQUIRED = YES');
      expect(report).not.toMatch(/sb_secret_|sb_publishable_|eyJhbGci|postgres:\/\/|@/);
      expect(report).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it('keeps optional integrations disabled by default', () => {
      const original = process.env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED;
      try {
        delete process.env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED;
        expect(getOptionalGeminiEnv().GEMINI_ASSISTIVE_EXTRACTION_ENABLED).toBe(false);
      } finally {
        if (original !== undefined) process.env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED = original;
      }
      expect(isParticipantPreviewEmailEnabled({})).toBe(false);
      expect(isParticipantPreviewRemindersEnabled({} as NodeJS.ProcessEnv)).toBe(false);
      expect(isStaffProvisioningEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    });
  });
});
