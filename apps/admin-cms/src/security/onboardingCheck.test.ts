import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  performOnboardingCheck,
  isVersionInNode24Range,
  isVersionInNpm11Range,
  validateMigrationsList,
  parseSemverMajorMinorPatch,
  sanitizePublicSafeMessage,
} from '../scripts/onboardingCheck';

describe('Harden Second-Developer Onboarding Precheck Unit Tests', () => {
  const realRepoRoot = path.resolve(__dirname, '../../../..');

  const validMigrations = [
    '20260601035138_staging_schema.sql',
    '20260601035139_staging_rls_policies.sql',
    '20260715102956_admin_auth_identity.sql',
    '20260719003407_explicit_data_api_grants.sql',
    '20260719165118_initial_admin_bootstrap.sql',
    '20260719165119_fix_initial_admin_bootstrap_runtime.sql',
    '20260803174000_harden_function_execute_defaults.sql',
    '20260803180000_transactional_review_actions.sql',
    '20260808170000_transactional_project_metadata_update.sql',
    '20260810090000_atomic_browser_import_metadata_stage.sql',
    '20260810120000_atomic_browser_import_media_stage.sql',
    '20260810150000_atomic_import_batch_review_submit.sql',
    '20260810180000_participant_preview_links.sql',
    '20260811090000_participant_preview_confirmations.sql',
    '20260811120000_participant_preview_correction_requests.sql',
    '20260811130000_participant_preview_correction_resolution.sql',
    '20260811150000_publication_readiness_gate.sql',
    '20260811160000_approval_edit_gate.sql',
    '20260812120000_controlled_publication_execution.sql',
    '20260812150000_controlled_public_removal.sql',
    '20260813002154_project_metadata_audit_history.sql',
    '20260813120000_staff_identity_provisioning.sql',
    '20260813180000_participant_preview_email_notifications.sql',
    '20260813190000_participant_preview_reminder_schedules.sql',
    '20260814090000_accessible_full_text_gate.sql',
    '20260814140000_snapshot_image_alt_text.sql',
    '20260816144917_staging_uat_direct_account_finalization.sql',
    '20260817090000_private_media_approval_gate.sql',
    '20260819214431_password_recovery_session_provenance.sql',
    '20260820120000_assistive_validation_persistence.sql',
    '20260820160000_assistive_validation_job_coordination.sql',
  ];

  const defaultMockExec = (cmd: string): string => {
    if (cmd === 'npm -v') return '11.11.0';
    if (cmd === 'docker --version') return 'Docker version 27.0.3';
    if (cmd === 'docker info') return 'Server running';
    if (cmd === 'git --version') return 'git version 2.45.0';
    if (cmd.includes('git -C') && cmd.includes('rev-parse --is-inside-work-tree')) return 'true';
    if (cmd.includes('git -C') && cmd.includes('ls-files')) return 'README.md\npackage.json\ninfra/supabase/config.toml';
    if (cmd === 'git ls-files') return 'README.md\npackage.json\ninfra/supabase/config.toml';
    return '';
  };

  const defaultFsOverride = {
    existsSync: (p: string) => {
      const norm = p.replace(/\\/g, '/');
      if (norm.endsWith('node_modules/supabase/bin/supabase.exe')) return true;
      if (norm.endsWith('node_modules/supabase/bin/supabase')) return true;
      if (norm.endsWith('node_modules/.bin/supabase.cmd')) return true;
      if (norm.endsWith('node_modules/.bin/supabase')) return true;
      if (norm.endsWith('node_modules/supabase/package.json')) return true;
      if (norm.endsWith('package.json')) return true;
      if (norm.endsWith('package-lock.json')) return true;
      if (norm.includes('infra/supabase/config.toml')) return true;
      if (norm.includes('infra/supabase/migrations')) return true;
      if (norm.includes('apps/admin-cms/src/scripts')) return true;
      if (norm.endsWith('.gitignore')) return true;
      return false;
    },
    readFileSync: (p: string, _enc?: string) => {
      void _enc;
      const norm = p.replace(/\\/g, '/');
      if (norm.endsWith('node_modules/supabase/package.json')) {
        return JSON.stringify({ version: '2.109.1', bin: { supabase: 'bin/supabase' } });
      }
      if (norm.endsWith('package.json')) {
        return JSON.stringify({ devDependencies: { supabase: '2.109.1' } });
      }
      if (norm.endsWith('.gitignore')) {
        return '.env.local\n.local-users.json\nnode_modules\n';
      }
      return '';
    },
    readdirSync: () => [...validMigrations],
  };

  it('1. Supported Node 24 (24.14.1) and npm 11 (11.11.0) pass toolchain checks', () => {
    expect(parseSemverMajorMinorPatch('24.14.1')).toEqual({ major: 24, minor: 14, patch: 1 });
    expect(isVersionInNode24Range('24.14.1')).toBe(true);
    expect(isVersionInNode24Range('v24.14.1')).toBe(true);
    expect(isVersionInNpm11Range('11.11.0')).toBe(true);

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(true);
    const nodeItem = result.items.find((i) => i.name.includes('Node.js Toolchain'));
    expect(nodeItem?.passed).toBe(true);
    const npmItem = result.items.find((i) => i.name.includes('npm Package Manager'));
    expect(npmItem?.passed).toBe(true);
  });

  it('2. Node 20 (20.18.0) fails toolchain check', () => {
    expect(isVersionInNode24Range('20.18.0')).toBe(false);

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v20.18.0',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(false);
    const nodeItem = result.items.find((i) => i.name.includes('Node.js Toolchain'));
    expect(nodeItem?.passed).toBe(false);
    expect(nodeItem?.message).toContain('does not satisfy supported Node 24 range');
  });

  it('3. npm 10 (10.8.2) fails toolchain check', () => {
    expect(isVersionInNpm11Range('10.8.2')).toBe(false);

    const mockExecNpm10 = (cmd: string) => (cmd === 'npm -v' ? '10.8.2' : defaultMockExec(cmd));
    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: mockExecNpm10,
      nodeVersion: 'v24.14.1',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(false);
    const npmItem = result.items.find((i) => i.name.includes('npm Package Manager'));
    expect(npmItem?.passed).toBe(false);
    expect(npmItem?.message).toContain('does not satisfy supported npm 11 range');
  });

  it('4. Docker daemon unavailable fails', () => {
    const mockExecNoDocker = (cmd: string) => {
      if (cmd === 'docker info') throw new Error('Docker daemon not running');
      return defaultMockExec(cmd);
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: mockExecNoDocker,
      nodeVersion: 'v24.14.1',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(false);
    const item = result.items.find((i) => i.name.includes('Docker Daemon Reachability'));
    expect(item?.passed).toBe(false);
    expect(item?.message).toContain('Docker daemon is not reachable');
  });

  it('5. Git CLI unavailable fails', () => {
    const mockExecNoGit = (cmd: string) => {
      if (cmd.includes('git')) throw new Error('git not found');
      return defaultMockExec(cmd);
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: mockExecNoGit,
      nodeVersion: 'v24.14.1',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(false);
    const item = result.items.find((i) => i.name.includes('Git CLI'));
    expect(item?.passed).toBe(false);
  });

  it('6. git ls-files failure fails rather than passing', () => {
    const mockExecGitLsFail = (cmd: string) => {
      if (cmd.includes('ls-files')) throw new Error('fatal: not a git repository');
      return defaultMockExec(cmd);
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: mockExecGitLsFail,
      nodeVersion: 'v24.14.1',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(false);
    const trackedItem = result.items.find((i) => i.name.includes('No Tracked Local Credential Files'));
    expect(trackedItem?.passed).toBe(false);
    expect(trackedItem?.message).toContain('Cannot verify tracked credentials because Git CLI index is unavailable');
  });

  it('7. A tracked .env.local fails', () => {
    const mockExecTrackedEnv = (cmd: string) => {
      if (cmd.includes('ls-files')) return 'README.md\napps/admin-cms/.env.local';
      return defaultMockExec(cmd);
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: mockExecTrackedEnv,
      nodeVersion: 'v24.14.1',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(false);
    const trackedItem = result.items.find((i) => i.name.includes('No Tracked Local Credential Files'));
    expect(trackedItem?.passed).toBe(false);
    expect(trackedItem?.message).toContain('tracked in git index');
  });

  it('8. A tracked .local-users.json fails', () => {
    const mockExecTrackedUsers = (cmd: string) => {
      if (cmd.includes('ls-files')) return 'README.md\napps/admin-cms/.local-users.json';
      return defaultMockExec(cmd);
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: mockExecTrackedUsers,
      nodeVersion: 'v24.14.1',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(false);
    const trackedItem = result.items.find((i) => i.name.includes('No Tracked Local Credential Files'));
    expect(trackedItem?.passed).toBe(false);
  });

  it('9. Valid migrations pass even when mocked directory enumeration is shuffled', () => {
    const shuffled = [...validMigrations].reverse();
    const result = validateMigrationsList(shuffled);
    expect(result.passed).toBe(true);
    expect(result.message).toContain('31 timestamped migrations');
  });

  it('10. Duplicate migration timestamps fail', () => {
    const duplicateMigrations = [
      '20260601035138_staging_schema.sql',
      '20260601035138_duplicate_timestamp.sql',
      '20260715102956_admin_auth_identity.sql',
      '20260719003407_explicit_data_api_grants.sql',
      '20260719165118_initial_admin_bootstrap.sql',
      '20260719165119_fix_initial_admin_bootstrap_runtime.sql',
      '20260803174000_harden_function_execute_defaults.sql',
      '20260803180000_transactional_review_actions.sql',
      '20260808170000_transactional_project_metadata_update.sql',
      '20260810090000_atomic_browser_import_metadata_stage.sql',
      '20260810120000_atomic_browser_import_media_stage.sql',
      '20260810150000_atomic_import_batch_review_submit.sql',
      '20260810180000_participant_preview_links.sql',
      '20260811090000_participant_preview_confirmations.sql',
      '20260811120000_participant_preview_correction_requests.sql',
      '20260811130000_participant_preview_correction_resolution.sql',
      '20260811150000_publication_readiness_gate.sql',
      '20260811160000_approval_edit_gate.sql',
      '20260812120000_controlled_publication_execution.sql',
      '20260812150000_controlled_public_removal.sql',
      '20260813002154_project_metadata_audit_history.sql',
      '20260813120000_staff_identity_provisioning.sql',
      '20260813180000_participant_preview_email_notifications.sql',
      '20260813190000_participant_preview_reminder_schedules.sql',
      '20260814090000_accessible_full_text_gate.sql',
      '20260814140000_snapshot_image_alt_text.sql',
      '20260816144917_staging_uat_direct_account_finalization.sql',
      '20260817090000_private_media_approval_gate.sql',
      '20260819214431_password_recovery_session_provenance.sql',
      '20260820120000_assistive_validation_persistence.sql',
      '20260820160000_assistive_validation_job_coordination.sql',
    ];
    const result = validateMigrationsList(duplicateMigrations);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Duplicate migration timestamps detected');
  });

  it('11. Missing migration 0008 fails', () => {
    const missing0008 = [
      '20260601035138_staging_schema.sql',
      '20260601035139_staging_rls_policies.sql',
      '20260715102956_admin_auth_identity.sql',
      '20260719003407_explicit_data_api_grants.sql',
      '20260719165118_initial_admin_bootstrap.sql',
      '20260719165119_fix_initial_admin_bootstrap_runtime.sql',
      '20260803174000_harden_function_execute_defaults.sql',
      '20260803180000_wrong_name.sql',
      '20260808170000_transactional_project_metadata_update.sql',
      '20260810090000_atomic_browser_import_metadata_stage.sql',
      '20260810120000_atomic_browser_import_media_stage.sql',
      '20260810150000_atomic_import_batch_review_submit.sql',
      '20260810180000_participant_preview_links.sql',
      '20260811090000_participant_preview_confirmations.sql',
      '20260811120000_participant_preview_correction_requests.sql',
      '20260811130000_participant_preview_correction_resolution.sql',
      '20260811150000_publication_readiness_gate.sql',
      '20260811160000_approval_edit_gate.sql',
      '20260812120000_controlled_publication_execution.sql',
      '20260812150000_controlled_public_removal.sql',
      '20260813002154_project_metadata_audit_history.sql',
      '20260813120000_staff_identity_provisioning.sql',
      '20260813180000_participant_preview_email_notifications.sql',
      '20260813190000_participant_preview_reminder_schedules.sql',
      '20260814090000_accessible_full_text_gate.sql',
      '20260814140000_snapshot_image_alt_text.sql',
      '20260816144917_staging_uat_direct_account_finalization.sql',
      '20260817090000_private_media_approval_gate.sql',
      '20260819214431_password_recovery_session_provenance.sql',
      '20260820120000_assistive_validation_persistence.sql',
      '20260820160000_assistive_validation_job_coordination.sql',
    ];
    const result = validateMigrationsList(missing0008);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Migration file at index 7 does not match expected identity');
  });

  it('12. Installed Supabase package missing fails', () => {
    const fsMissingPkg = {
      ...defaultFsOverride,
      existsSync: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('node_modules/supabase/package.json')) return false;
        return defaultFsOverride.existsSync(p);
      },
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: fsMissingPkg,
    });

    expect(result.passed).toBe(false);
    const item = result.items.find((i) => i.name.includes('Installed Supabase CLI'));
    expect(item?.passed).toBe(false);
    expect(item?.message).toContain('missing');
  });

  it('13. Installed Supabase version mismatch fails', () => {
    const fsWrongVer = {
      ...defaultFsOverride,
      readFileSync: (p: string, _enc?: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('node_modules/supabase/package.json')) {
          return JSON.stringify({ version: '2.100.0', bin: { supabase: 'bin/supabase' } });
        }
        return defaultFsOverride.readFileSync(p, _enc);
      },
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: fsWrongVer,
    });

    expect(result.passed).toBe(false);
    const item = result.items.find((i) => i.name.includes('Installed Supabase CLI'));
    expect(item?.passed).toBe(false);
    expect(item?.message).toContain('version is not 2.109.1');
  });

  it('14. Missing local Supabase binary fails', () => {
    const fsNoBinary = {
      ...defaultFsOverride,
      existsSync: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        if (
          norm.endsWith('node_modules/supabase/bin/supabase.exe') ||
          norm.endsWith('node_modules/supabase/bin/supabase') ||
          norm.endsWith('node_modules/.bin/supabase.cmd') ||
          norm.endsWith('node_modules/.bin/supabase')
        ) {
          return false;
        }
        return defaultFsOverride.existsSync(p);
      },
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: fsNoBinary,
    });

    expect(result.passed).toBe(false);
    const item = result.items.find((i) => i.name.includes('Installed Supabase CLI'));
    expect(item?.passed).toBe(false);
  });

  it('15. Git commands are anchored using repoRoot with safe quoting for paths with spaces', () => {
    const executedCmds: string[] = [];
    const repoWithSpaces = 'D:\\IT RMIT\\Capstone Impact Platform';

    const customExec = (cmd: string): string => {
      executedCmds.push(cmd);
      if (cmd.includes('git -C') && cmd.includes('rev-parse --is-inside-work-tree')) return 'true';
      if (cmd.includes('git -C') && cmd.includes('ls-files')) return 'README.md\npackage.json';
      return defaultMockExec(cmd);
    };

    const result = performOnboardingCheck({
      repoRoot: repoWithSpaces,
      execRunner: customExec,
      nodeVersion: 'v24.14.1',
      fsOverride: defaultFsOverride,
    });

    expect(result.passed).toBe(true);
    const gitCmds = executedCmds.filter((c) => c.includes('git -C'));
    expect(gitCmds.length).toBeGreaterThanOrEqual(2);
    expect(gitCmds[0]).toContain(`git -C "D:\\IT RMIT\\Capstone Impact Platform"`);
  });

  it('16. Installed Supabase package supports string bin form', () => {
    const fsStringBin = {
      ...defaultFsOverride,
      readFileSync: (p: string, _enc?: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('node_modules/supabase/package.json')) {
          return JSON.stringify({ version: '2.109.1', bin: 'bin/supabase' });
        }
        return defaultFsOverride.readFileSync(p, _enc);
      },
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: fsStringBin,
    });

    expect(result.passed).toBe(true);
  });

  it('17. Installed Supabase package supports object bin form', () => {
    const fsObjectBin = {
      ...defaultFsOverride,
      readFileSync: (p: string, _enc?: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('node_modules/supabase/package.json')) {
          return JSON.stringify({ version: '2.109.1', bin: { supabase: 'bin/supabase' } });
        }
        return defaultFsOverride.readFileSync(p, _enc);
      },
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: fsObjectBin,
    });

    expect(result.passed).toBe(true);
  });

  it('18. Missing declared bin entry in Supabase package.json fails', () => {
    const fsNoBinEntry = {
      ...defaultFsOverride,
      readFileSync: (p: string, _enc?: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('node_modules/supabase/package.json')) {
          return JSON.stringify({ version: '2.109.1' }); // no bin key
        }
        return defaultFsOverride.readFileSync(p, _enc);
      },
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: fsNoBinEntry,
    });

    expect(result.passed).toBe(false);
    const item = result.items.find((i) => i.name.includes('Installed Supabase CLI'));
    expect(item?.passed).toBe(false);
    expect(item?.message).toContain('does not declare a valid target');
  });

  it('19. Missing declared bin target file fails', () => {
    const fsMissingDeclaredTarget = {
      ...defaultFsOverride,
      existsSync: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('node_modules/supabase/bin/supabase')) return false;
        if (norm.endsWith('node_modules/supabase/bin/supabase.exe')) return false;
        return defaultFsOverride.existsSync(p);
      },
      readFileSync: (p: string, _enc?: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('node_modules/supabase/package.json')) {
          return JSON.stringify({ version: '2.109.1', bin: { supabase: 'bin/supabase' } });
        }
        return defaultFsOverride.readFileSync(p, _enc);
      },
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: fsMissingDeclaredTarget,
    });

    expect(result.passed).toBe(false);
    const item = result.items.find((i) => i.name.includes('Installed Supabase CLI'));
    expect(item?.passed).toBe(false);
  });

  it('20. Missing npm .bin shim fails', () => {
    const fsMissingShim = {
      ...defaultFsOverride,
      existsSync: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('node_modules/.bin/supabase.cmd') || norm.endsWith('node_modules/.bin/supabase')) {
          return false;
        }
        return defaultFsOverride.existsSync(p);
      },
    };

    const result = performOnboardingCheck({
      repoRoot: realRepoRoot,
      execRunner: defaultMockExec,
      nodeVersion: 'v24.14.1',
      fsOverride: fsMissingShim,
    });

    expect(result.passed).toBe(false);
    const item = result.items.find((i) => i.name.includes('Installed Supabase CLI'));
    expect(item?.passed).toBe(false);
    expect(item?.message).toContain('Local npm .bin shim for Supabase CLI is missing');
  });

  it('21. Exact expected migration filenames are required', () => {
    const invalidMigrationNames = [
      '20260601035138_staging_schema.sql',
      '20260601035139_staging_rls_policies.sql',
      '20260715102956_admin_auth_identity.sql',
      '20260719003407_explicit_data_api_grants.sql',
      '20260719165118_initial_admin_bootstrap.sql',
      '20260719165119_fix_initial_admin_bootstrap_runtime.sql',
      '20260803174000_harden_function_execute_defaults.sql',
      '20260803180000_different_migration_name.sql',
      '20260808170000_transactional_project_metadata_update.sql',
      '20260810090000_atomic_browser_import_metadata_stage.sql',
      '20260810120000_atomic_browser_import_media_stage.sql',
      '20260810150000_atomic_import_batch_review_submit.sql',
      '20260810180000_participant_preview_links.sql',
      '20260811090000_participant_preview_confirmations.sql',
      '20260811120000_participant_preview_correction_requests.sql',
      '20260811130000_participant_preview_correction_resolution.sql',
      '20260811150000_publication_readiness_gate.sql',
      '20260811160000_approval_edit_gate.sql',
      '20260812120000_controlled_publication_execution.sql',
      '20260812150000_controlled_public_removal.sql',
      '20260813002154_project_metadata_audit_history.sql',
      '20260813120000_staff_identity_provisioning.sql',
      '20260813180000_participant_preview_email_notifications.sql',
      '20260813190000_participant_preview_reminder_schedules.sql',
      '20260814090000_accessible_full_text_gate.sql',
      '20260814140000_snapshot_image_alt_text.sql',
      '20260816144917_staging_uat_direct_account_finalization.sql',
      '20260817090000_private_media_approval_gate.sql',
      '20260819214431_password_recovery_session_provenance.sql',
      '20260820120000_assistive_validation_persistence.sql',
      '20260820160000_assistive_validation_job_coordination.sql',
    ];
    const result = validateMigrationsList(invalidMigrationNames);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Migration file at index 7 does not match expected identity');
  });

  it('22. Windows path with spaces is sanitized', () => {
    const winPathWithSpaces = 'FAIL: Error in C:\\Users\\John Doe\\My Projects\\capstone\\config.toml';
    const sanitized = sanitizePublicSafeMessage(winPathWithSpaces);
    expect(sanitized).not.toContain('C:\\Users\\John Doe\\My Projects\\capstone\\config.toml');
    expect(sanitized).toContain('<relative-path>');
  });

  it('23. Unix home path with spaces is sanitized', () => {
    const unixPathWithSpaces = 'FAIL: Path /home/john doe/projects/capstone/config.toml failed';
    const sanitized = sanitizePublicSafeMessage(unixPathWithSpaces);
    expect(sanitized).not.toContain('/home/john doe/projects/capstone/config.toml');
    expect(sanitized).toContain('<relative-path>');
  });
});
