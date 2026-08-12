import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('metadata runtime CI contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

  it('runs the Docker-dependent metadata verifier only in disposable local Supabase integration', () => {
    const localIntegration = workflow.match(/  local-integration:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0] ?? '';
    const staticQuality = workflow.match(/  static-quality:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0] ?? '';
    const contributorRehearsal = workflow.match(/  contributor-rehearsal:[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0] ?? '';

    expect(localIntegration).toContain('Verify atomic project metadata runtime behavior');
    expect(localIntegration).toContain('npm run verify:metadata-runtime --workspace=apps/admin-cms');
    expect(staticQuality).not.toContain('verify:metadata-runtime');
    expect(contributorRehearsal).not.toContain('verify:metadata-runtime');
  });
});
