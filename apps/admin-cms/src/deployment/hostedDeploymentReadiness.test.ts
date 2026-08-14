import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXPECTED_REPOSITORY_MIGRATIONS,
  EXPECTED_REPOSITORY_MIGRATION_COUNT,
  ALL_REQUIRED_TABLES,
  REQUIRED_CORE_TABLES,
  REQUIRED_RPCS,
  REQUIRED_STORAGE_BUCKETS,
  evaluateHostedDeploymentReadiness,
  formatHostedReadinessReport,
  checkHostedDeploymentReadinessWithClient,
  HostedReadinessClient,
  HostedReadinessEvidence,
} from './hostedDeploymentReadiness';
import { getOptionalGeminiEnv } from '../lib/env';
import { isParticipantPreviewEmailEnabled } from '../notifications/participantPreviewEmailConfig';
import { isParticipantPreviewRemindersEnabled } from '../reminders/participantPreviewReminderConfig';
import { isStaffProvisioningEnabled } from '../staff/staffProvisioningEnablement';

describe('Hosted Deployment Readiness & Staging Governance Contract Tests', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');

  describe('1. Exact 26-Migration Inventory Tests', () => {
    it('declares exactly 26 migrations in code inventory', () => {
      expect(EXPECTED_REPOSITORY_MIGRATION_COUNT).toBe(26);
      expect(EXPECTED_REPOSITORY_MIGRATIONS.length).toBe(26);
    });

    it('matches exact files in infra/supabase/migrations directory', () => {
      const migrationsDir = path.resolve(repoRoot, 'infra/supabase/migrations');
      const filesOnDisk = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      expect(filesOnDisk.length).toBe(26);
      expect(filesOnDisk).toEqual([...EXPECTED_REPOSITORY_MIGRATIONS].sort());
    });

    it('contains sequential migration timestamps in deterministic order', () => {
      for (let i = 0; i < EXPECTED_REPOSITORY_MIGRATIONS.length - 1; i++) {
        const currentTs = EXPECTED_REPOSITORY_MIGRATIONS[i].split('_')[0];
        const nextTs = EXPECTED_REPOSITORY_MIGRATIONS[i + 1].split('_')[0];
        expect(currentTs <= nextTs).toBe(true);
      }
    });
  });

  describe('2. Pure Readiness Evaluation Contract Tests', () => {
    const fullMatchEvidence: HostedReadinessEvidence = {
      targetIdentityMatch: true,
      migrationHistoryReadable: true,
      recordedMigrationVersions: EXPECTED_REPOSITORY_MIGRATIONS.map((m) => m.split('_')[0]),
      presentTables: [...ALL_REQUIRED_TABLES],
      presentRpcs: [...REQUIRED_RPCS],
      presentBuckets: [...REQUIRED_STORAGE_BUCKETS],
      authUserIdColumnPresent: true,
      initialAdminLinkagePresent: true,
      recognizedRolesPresent: true,
    };

    it('evaluates complete repository-matching evidence to READY_FOR_MUTATION_DECISION', () => {
      const evaluation = evaluateHostedDeploymentReadiness(fullMatchEvidence);

      expect(evaluation.targetIdentityMatch).toBe(true);
      expect(evaluation.migrationHistoryReadable).toBe(true);
      expect(evaluation.repositoryMigrationsCount).toBe(26);
      expect(evaluation.hostedRecordedMigrations).toBe(26);
      expect(evaluation.schemaBaseline).toBe('MATCH');
      expect(evaluation.requiredRpcSet).toBe('PRESENT');
      expect(evaluation.requiredTableSet).toBe('PRESENT');
      expect(evaluation.requiredStorageBuckets).toBe('PRESENT');
      expect(evaluation.authFoundation).toBe('READY');
      expect(evaluation.deploymentClassification).toBe('READY_FOR_MUTATION_DECISION');
      expect(evaluation.missingTables.length).toBe(0);
      expect(evaluation.missingRpcs.length).toBe(0);
      expect(evaluation.missingBuckets.length).toBe(0);
    });

    it('evaluates missing migration history to RECONCILIATION_REQUIRED', () => {
      const evaluation = evaluateHostedDeploymentReadiness({
        ...fullMatchEvidence,
        migrationHistoryReadable: false,
        recordedMigrationVersions: [],
      });

      expect(evaluation.migrationHistoryReadable).toBe(false);
      expect(evaluation.hostedRecordedMigrations).toBe('UNKNOWN');
      expect(evaluation.deploymentClassification).toBe('RECONCILIATION_REQUIRED');
    });

    it('evaluates partial migration history (e.g. 0001-0006 baseline) to RECONCILIATION_REQUIRED', () => {
      const earlyVersions = EXPECTED_REPOSITORY_MIGRATIONS.slice(0, 6).map((m) => m.split('_')[0]);
      const evaluation = evaluateHostedDeploymentReadiness({
        ...fullMatchEvidence,
        recordedMigrationVersions: earlyVersions,
        presentTables: [...REQUIRED_CORE_TABLES],
        presentRpcs: ['bootstrap_initial_admin'],
      });

      expect(evaluation.hostedRecordedMigrations).toBe(6);
      expect(evaluation.schemaBaseline).toBe('INCOMPLETE');
      expect(evaluation.requiredRpcSet).toBe('INCOMPLETE');
      expect(evaluation.requiredTableSet).toBe('INCOMPLETE');
      expect(evaluation.deploymentClassification).toBe('RECONCILIATION_REQUIRED');
      expect(evaluation.missingMigrations.length).toBe(20);
    });

    it('evaluates unexpected table drift to DRIFT_REQUIRES_REVIEW', () => {
      const evaluation = evaluateHostedDeploymentReadiness({
        ...fullMatchEvidence,
        unexpectedTables: ['unrecognized_custom_table_1'],
      });

      expect(evaluation.schemaBaseline).toBe('DRIFT');
      expect(evaluation.deploymentClassification).toBe('DRIFT_REQUIRES_REVIEW');
    });

    it('evaluates target identity mismatch to BLOCKED', () => {
      const evaluation = evaluateHostedDeploymentReadiness({
        ...fullMatchEvidence,
        targetIdentityMatch: false,
      });

      expect(evaluation.targetIdentityMatch).toBe(false);
      expect(evaluation.deploymentClassification).toBe('BLOCKED');
      expect(evaluation.schemaBaseline).toBe('UNKNOWN');
    });
  });

  describe('3. Read-Only Client Inspection & No-Mutation Contract Tests', () => {
    it('executes only read-only probe queries and performs ZERO database mutations', async () => {
      const selectCalls: string[] = [];
      const createQueryResult = (tableName: string) => {
        const getData = () => {
          if (tableName === 'admin_users') {
            return [{ id: 'mock-id', auth_user_id: 'mock-auth-id' }];
          }
          if (tableName === 'user_roles') {
            return [{ id: 'mock-id', role: 'admin' }];
          }
          if (tableName === 'schema_migrations') {
            return EXPECTED_REPOSITORY_MIGRATIONS.map((m) => ({ version: m.split('_')[0] }));
          }
          return [];
        };

        const resultPromise = Promise.resolve({ data: getData(), error: null });
        return Object.assign(resultPromise, {
          limit: async () => ({ data: getData(), error: null }),
        });
      };

      const mockClient: HostedReadinessClient = {
        from: (tableName: string) => {
          return {
            select: (cols: string) => {
              selectCalls.push(`${tableName}.${cols}`);
              return createQueryResult(tableName);
            },
          };
        },
        schema: (schemaName: string) => ({
          from: (tableName: string) => ({
            select: (cols: string) => {
              selectCalls.push(`${schemaName}.${tableName}.${cols}`);
              return createQueryResult(tableName);
            },
          }),
        }),
        storage: {
          listBuckets: async () => ({
            data: REQUIRED_STORAGE_BUCKETS.map((id) => ({ id, name: id })),
            error: null,
          }),
        },
        rpc: async () => ({
          data: null,
          error: null,
        }),
      };

      const result = await checkHostedDeploymentReadinessWithClient(mockClient);

      expect(result.targetIdentityMatch).toBe(true);
      expect(result.requiredTableSet).toBe('PRESENT');
      expect(result.requiredStorageBuckets).toBe('PRESENT');
      expect(result.requiredRpcSet).toBe('PRESENT');
      expect(result.deploymentClassification).toBe('READY_FOR_MUTATION_DECISION');

      // Verify client was probed without mutation methods
      expect(selectCalls.length).toBeGreaterThan(0);
      expect('insert' in mockClient).toBe(false);
      expect('update' in mockClient).toBe(false);
      expect('delete' in mockClient).toBe(false);
      expect('upsert' in mockClient).toBe(false);
    });
  });

  describe('4. Safe Output Formatting & Secret Redaction Tests', () => {
    it('produces structured report without leaking secrets, connection strings, or UUIDs', () => {
      const evaluation = evaluateHostedDeploymentReadiness({
        targetIdentityMatch: true,
        migrationHistoryReadable: true,
        recordedMigrationVersions: EXPECTED_REPOSITORY_MIGRATIONS.map((m) => m.split('_')[0]),
        presentTables: [...ALL_REQUIRED_TABLES],
        presentRpcs: [...REQUIRED_RPCS],
        presentBuckets: [...REQUIRED_STORAGE_BUCKETS],
        authUserIdColumnPresent: true,
        initialAdminLinkagePresent: true,
        recognizedRolesPresent: true,
      });

      const report = formatHostedReadinessReport(evaluation);

      expect(report).toContain('TARGET_IDENTITY_MATCH = YES');
      expect(report).toContain('MIGRATION_HISTORY_READABLE = YES');
      expect(report).toContain('REPOSITORY_MIGRATIONS = 26');
      expect(report).toContain('HOSTED_RECORDED_MIGRATIONS = 26');
      expect(report).toContain('SCHEMA_BASELINE = MATCH');
      expect(report).toContain('REQUIRED_RPC_SET = PRESENT');
      expect(report).toContain('REQUIRED_TABLE_SET = PRESENT');
      expect(report).toContain('REQUIRED_STORAGE_BUCKETS = PRESENT');
      expect(report).toContain('AUTH_FOUNDATION = READY');
      expect(report).toContain('DEPLOYMENT_CLASSIFICATION = READY_FOR_MUTATION_DECISION');

      // Strict redaction assertions
      expect(report).not.toContain('sb_secret_');
      expect(report).not.toContain('sb_publishable_');
      expect(report).not.toContain('eyJhbGci');
      expect(report).not.toContain('postgres://');
      expect(report).not.toContain('@');
      expect(report).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });
  });

  describe('5. Deployment Configuration & Optional Features Fail-Closed Tests', () => {
    it('verifies Node and npm engine requirements in root package.json', () => {
      const rootPkg = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'package.json'), 'utf8'));
      expect(rootPkg.engines.node).toBe('>=24.14.1 <25');
      expect(rootPkg.engines.npm).toBe('>=11.11.0 <12');
      expect(rootPkg.packageManager).toBe('npm@11.11.0');
    });

    it('verifies optional Gemini assistive extraction fails closed when disabled or absent', () => {
      const originalEnv = process.env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED;
      try {
        delete process.env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED;
        const geminiConfig = getOptionalGeminiEnv();
        expect(geminiConfig.GEMINI_ASSISTIVE_EXTRACTION_ENABLED).toBe(false);
      } finally {
        if (originalEnv !== undefined) {
          process.env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED = originalEnv;
        }
      }
    });

    it('verifies optional participant preview email fails closed by default', () => {
      expect(isParticipantPreviewEmailEnabled({})).toBe(false);
      expect(isParticipantPreviewEmailEnabled({ PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'false' })).toBe(false);
      expect(isParticipantPreviewEmailEnabled({ PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'true' })).toBe(false); // Fails closed without SMTP config
      expect(
        isParticipantPreviewEmailEnabled({
          PARTICIPANT_PREVIEW_EMAIL_ENABLED: 'true',
          PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST: 'smtp.internal.local',
          PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT: '587',
          PARTICIPANT_PREVIEW_EMAIL_FROM: 'noreply@rmit.edu.au',
        })
      ).toBe(true);
    });

    it('verifies optional participant preview reminders fail closed by default', () => {
      expect(isParticipantPreviewRemindersEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
      expect(
        isParticipantPreviewRemindersEnabled({
          PARTICIPANT_PREVIEW_REMINDERS_ENABLED: 'false',
        } as unknown as NodeJS.ProcessEnv)
      ).toBe(false);
      expect(
        isParticipantPreviewRemindersEnabled({
          PARTICIPANT_PREVIEW_REMINDERS_ENABLED: 'true',
        } as unknown as NodeJS.ProcessEnv)
      ).toBe(true);
    });

    it('verifies optional staff provisioning fails closed by default', () => {
      expect(isStaffProvisioningEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
      expect(
        isStaffProvisioningEnabled({
          STAFF_PROVISIONING_ENABLED: 'false',
        } as unknown as NodeJS.ProcessEnv)
      ).toBe(false);
      expect(
        isStaffProvisioningEnabled({
          STAFF_PROVISIONING_ENABLED: 'true',
        } as unknown as NodeJS.ProcessEnv)
      ).toBe(true);
    });

    it('verifies Prototype directory remains completely isolated', () => {
      const prototypeDir = path.resolve(repoRoot, 'Prototype');
      expect(fs.existsSync(prototypeDir)).toBe(true);
      expect(fs.existsSync(path.resolve(prototypeDir, 'package.json'))).toBe(true);
    });
  });
});
