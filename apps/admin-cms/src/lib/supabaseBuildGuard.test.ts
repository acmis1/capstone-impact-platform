import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const adminAppRoot = fileURLToPath(new URL('../../', import.meta.url));
const configImport = "await import('./next.config.ts')";

function syntheticJwt(payload: unknown) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${header}.${encodedPayload}.synthetic-signature`;
}

function runConfigInitialization(keys: {
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
}) {
  const environment = { ...process.env };
  delete environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete environment.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  Object.assign(environment, keys);

  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', configImport],
    {
      cwd: adminAppRoot,
      env: environment,
      encoding: 'utf8',
    },
  );
}

describe('Next.js Supabase public credential build guard', () => {
  it('initializes with a modern publishable credential', () => {
    const result = runConfigInitialization({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic-build-value',
    });

    expect(result.status).toBe(0);
  });

  it('initializes with a valid legacy anon credential', () => {
    const result = runConfigInitialization({
      NEXT_PUBLIC_SUPABASE_ANON_KEY: syntheticJwt({ role: 'anon' }),
    });

    expect(result.status).toBe(0);
  });

  it('fails config initialization when either public variable contains a privileged credential', () => {
    const privateCredential = syntheticJwt({
      role: 'service_role',
      private_claim: 'must-not-appear',
    });
    const result = runConfigInitialization({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic-build-value',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: privateCredential,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('Supabase browser credential configuration is unsafe');
    expect(output).not.toContain(privateCredential);
    expect(output).not.toContain('must-not-appear');
    expect(output).not.toContain('service_role');
  });
});
