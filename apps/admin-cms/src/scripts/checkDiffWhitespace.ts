import { execSync } from 'node:child_process';
import path from 'node:path';

export interface DiffCheckOptions {
  repoRoot?: string;
  eventName?: string;
  baseSha?: string;
  headSha?: string;
  beforeSha?: string;
  currentSha?: string;
  execRunner?: (cmd: string) => string;
}

export function runDiffCheck(options?: DiffCheckOptions): { success: boolean; mode: string; detail?: string } {
  const repoRoot = options?.repoRoot || path.resolve(__dirname, '../../../../');
  const exec = options?.execRunner || ((cmd: string) => execSync(cmd, { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  const eventName = options?.eventName || process.env.GITHUB_EVENT_NAME || '';

  try {
    if (eventName === 'pull_request') {
      const base = options?.baseSha || process.env.GITHUB_PR_BASE_SHA || '';
      const head = options?.headSha || process.env.GITHUB_PR_HEAD_SHA || '';

      if (base && head) {
        exec(`git diff --check "${base}"..."${head}"`);
        return { success: true, mode: `pr_diff (${base}...${head})` };
      }
    }

    const before = options?.beforeSha || process.env.GITHUB_BEFORE_SHA || '';
    const current = options?.currentSha || process.env.GITHUB_CURRENT_SHA || process.env.GITHUB_SHA || '';

    if (before && before !== '0000000000000000000000000000000000000000' && current) {
      exec(`git diff --check "${before}"..."${current}"`);
      return { success: true, mode: `push_diff (${before}...${current})` };
    }

    exec('git diff --check');
    return { success: true, mode: 'working_tree' };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return { success: false, mode: 'error', detail };
  }
}

if (process.argv[1] && process.argv[1].endsWith('checkDiffWhitespace.ts')) {
  const result = runDiffCheck();
  if (result.success) {
    console.log(`✅ Diff whitespace check PASSED (${result.mode}).`);
  } else {
    console.error(`❌ Diff whitespace check FAILED: ${result.detail}`);
    process.exit(1);
  }
}
