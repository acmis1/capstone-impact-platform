import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Phase 4 coordinator authority and process boundary', () => {
  const root = join(process.cwd(), 'src', 'assistive-validation');
  const read = (relative: string) => readFileSync(join(root, relative), 'utf8');
  const code = (relative: string) => read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('keeps privileged client construction outside reusable assistive modules', () => {
    for (const file of [
      'repositories/assistiveJobRepository.ts',
      'repositories/assistiveInputRepository.ts',
      'services/assistiveCoordinator.ts',
      'services/assistiveInputService.ts',
      'services/assistiveJobService.ts',
      'services/pythonWorkerProcess.ts',
    ]) {
      expect(code(file)).not.toMatch(/createClient\s*\(|createSupabaseAdminClient/);
    }
  });

  it('allows job writes only through the bounded Migration 31 RPCs', () => {
    const repository = code('repositories/assistiveJobRepository.ts');
    expect(repository).not.toMatch(/\.from\(/);
    expect(repository).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    const names = [...repository.matchAll(/this\.rpc\('([^']+)'/g)].map((match) => match[1]).sort();
    expect(names).toEqual([
      'advance_assistive_validation_job_stage',
      'claim_next_assistive_validation_job',
      'enqueue_assistive_validation_run',
      'finalize_assistive_validation_job',
      'get_assistive_validation_job_health',
      'get_assistive_validation_run_status',
      'heartbeat_assistive_validation_job',
      'record_assistive_validation_job_failure',
      'request_assistive_validation_cancellation',
      'supersede_assistive_validation_job',
    ]);
  });

  it('limits input access to read-only project, private media metadata, and storage download', () => {
    const repository = code('repositories/assistiveInputRepository.ts');
    expect(repository.match(/this\.client\.from\(/g)).toHaveLength(3);
    expect(repository.match(/\.from\('projects'\)/g)).toHaveLength(2);
    expect(repository).toContain(".from('media_assets')");
    expect(repository).toContain('.download(');
    expect(repository).toContain(".is('deleted_at', null)");
    expect(repository).toContain(".neq('id', projectId)");
    expect(repository).not.toMatch(/\.eq\('status'/);
    expect(repository).not.toMatch(/\.(insert|update|delete|upsert|upload|remove|move|copy)\(/);
  });

  it('spawns fixed argument arrays without a shell and strips Supabase credentials', () => {
    const processSource = code('services/pythonWorkerProcess.ts');
    expect(processSource).toContain("'-m', 'capstone_assistive_worker.task_cli'");
    expect(processSource).toContain('shell: false');
    expect(processSource).not.toContain('shell: true');
    expect(processSource).not.toMatch(/SUPABASE|SERVICE_ROLE|SECRET_KEY|ANON_KEY/);
    expect(processSource).toContain('CAPSTONE_ASSISTIVE_PARENT_PID');
    expect(processSource).toContain('MAX_STDOUT_BYTES');
    expect(processSource).toContain('MAX_STDERR_BYTES');
    expect(processSource).toContain("spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']");
    expect(processSource).toContain("process.kill(-child.pid, 'SIGKILL')");
  });

  it('has no authoritative mutation, publication, hosted AI, or external queue dependency', () => {
    const combined = [
      'services/assistiveCoordinator.ts',
      'services/assistiveInputService.ts',
      'services/assistiveJobService.ts',
      'repositories/assistiveJobRepository.ts',
      'repositories/assistiveInputRepository.ts',
    ].map(code).join('\n');
    expect(combined).not.toMatch(
      /update_project_metadata|submit_project_for_review|publication|approval|duda|gemini|openai|anthropic|redis|rabbit|kafka|sqs/i,
    );
    expect(combined).not.toMatch(/@google\/genai|fetch\s*\(/);
  });

  it('makes the operator process refuse non-loopback Supabase configuration', () => {
    const entrypoint = readFileSync(join(process.cwd(), 'src', 'scripts', 'runAssistiveCoordinator.ts'), 'utf8');
    expect(entrypoint).toContain('isLoopbackUrl(local.API_URL)');
    expect(entrypoint).toContain('Local Supabase');
    expect(entrypoint).not.toMatch(/getServerEnv|createSupabaseAdminClient/);
  });
});
