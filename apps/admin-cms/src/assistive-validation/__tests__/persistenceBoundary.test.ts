import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 3 makes non-authoritative observations durable. Persisting or reviewing one must never be
 * able to change project workflow state, so the persistence code is held to a dependency boundary
 * rather than only to a behavioural one.
 */
describe('assistive persistence authority boundary', () => {
  const domainRoot = join(process.cwd(), 'src', 'assistive-validation');
  const sourceFiles = readdirSync(domainRoot, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.ts') && !entry.includes('__tests__'));

  const importsOf = (source: string): string[] =>
    [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);

  /**
   * Comments are stripped before the name scans below. These modules deliberately document the
   * boundary they respect, and prose naming a forbidden surface is the opposite of using it.
   */
  const codeOf = (source: string): string => source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('finds the Phase 3 persistence modules it is meant to police', () => {
    const normalized = sourceFiles.map((file) => file.split('\\').join('/'));
    expect(normalized).toContain('domain/persistenceContract.ts');
    expect(normalized).toContain('repositories/assistiveValidationRepository.ts');
    expect(normalized).toContain('services/assistiveValidationPersistenceService.ts');
  });

  it('never imports a module outside the assistive validation domain', () => {
    const allowedPackages = new Set(['zod', '@supabase/supabase-js']);

    for (const file of sourceFiles) {
      const absolute = join(domainRoot, file);
      for (const specifier of importsOf(readFileSync(absolute, 'utf8'))) {
        if (!specifier.startsWith('.')) {
          expect(allowedPackages.has(specifier), `${file} imports package ${specifier}`).toBe(true);
          continue;
        }
        const resolved = resolve(absolute, '..', specifier);
        const escaped = relative(domainRoot, resolved).split('\\').join('/');
        expect(escaped.startsWith('..'), `${file} imports outside the domain: ${specifier}`).toBe(false);
        expect(posix.isAbsolute(escaped), `${file} imports absolutely: ${specifier}`).toBe(false);
      }
    }
  });

  it('references no authoritative mutation, publication, or model surface by name', () => {
    const forbidden = [
      // Authoritative project and workflow mutation.
      'update_project_metadata', 'updateProjectMetadata', 'projectMetadataService',
      'submit_project_for_review', 'apply_review_action', 'reviewAction', 'approveProject',
      'publication_readiness', 'publicationReadiness', 'preparePublication',
      'execute_controlled_publication', 'controlledPublication', 'archiveProject',
      'remove_public_project', 'publish-cloud-feed', 'publishStagingFeed', 'duda', 'Duda',
      // Model and cloud AI activation.
      'gemini', 'Gemini', 'GoogleGenerativeAI', 'openai', 'anthropic',
      // Phase 4 job coordination.
      'assistive_validation_jobs', 'SKIP LOCKED', 'lease_until', 'workerId', 'claimJob',
    ];

    for (const file of sourceFiles) {
      const source = codeOf(readFileSync(join(domainRoot, file), 'utf8'));
      for (const term of forbidden) {
        expect(source.includes(term), `${file} references ${term}`).toBe(false);
      }
    }
  });

  it('reaches the database only through the three bounded Phase 3 functions', () => {
    const repository = readFileSync(
      join(domainRoot, 'repositories', 'assistiveValidationRepository.ts'),
      'utf8',
    );
    const rpcNames = [...repository.matchAll(/\.rpc\(\s*'([^']+)'/g)].map((match) => match[1]).sort();
    expect(rpcNames).toEqual([
      'get_latest_assistive_validation_run',
      'persist_assistive_validation_run',
      'record_assistive_finding_disposition',
    ]);
    // Both assistive tables revoke every privilege, so there is deliberately no direct table access.
    expect(repository).not.toMatch(/\.from\(/);
    expect(repository).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    // The raw provider error is converted into a bounded code and never returned to a caller.
    for (const code of [
      'ASSISTIVE_RUN_PERSIST_FAILED', 'ASSISTIVE_RUN_READ_FAILED', 'ASSISTIVE_DISPOSITION_FAILED',
    ]) {
      expect(repository).toContain(code);
    }
    expect(repository).not.toMatch(/throw\s+error|error\.message|JSON\.stringify\(error/);
  });

  it('never constructs a privileged client or reads a credential of its own', () => {
    for (const file of sourceFiles) {
      const source = codeOf(readFileSync(join(domainRoot, file), 'utf8'));
      expect(source).not.toMatch(/createClient\s*\(/);
      expect(source).not.toMatch(/process\.env/);
      expect(source).not.toMatch(/SERVICE_ROLE|SUPABASE_URL|ANON_KEY|SECRET/i);
    }
  });
});
