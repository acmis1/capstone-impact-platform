import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isLoopbackUrl,
  parseSupabaseCliEnv,
  buildLocalEnvContent,
  generateLocalEnvironmentFile,
  validateAllowedOutputPath,
} from './localEnvironmentFile';

describe('Local Environment File Generator Unit Tests', () => {
  let tmpDir: string;
  const repoRoot = path.resolve(__dirname, '../../../..');
  const defaultEnvPath = path.resolve(repoRoot, 'apps/admin-cms/.env.local');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. isLoopbackUrl correctly validates loopback addresses', () => {
    expect(isLoopbackUrl('http://127.0.0.1:54321')).toBe(true);
    expect(isLoopbackUrl('http://localhost:54321')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:54321')).toBe(true);

    expect(isLoopbackUrl('https://abc.supabase.co')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.100:54321')).toBe(false);
    expect(isLoopbackUrl('invalid-url')).toBe(false);
  });

  it('2. parseSupabaseCliEnv correctly parses key-value pairs', () => {
    const raw = `
# Comment line
API_URL="http://127.0.0.1:54321"
ANON_KEY=sb_anon_mock_123
SERVICE_ROLE_KEY='sb_service_mock_456'
`;
    const parsed = parseSupabaseCliEnv(raw);
    expect(parsed.API_URL).toBe('http://127.0.0.1:54321');
    expect(parsed.ANON_KEY).toBe('sb_anon_mock_123');
    expect(parsed.SERVICE_ROLE_KEY).toBe('sb_service_mock_456');
  });

  it('3. buildLocalEnvContent rejects non-loopback URLs with generic error without printing secret/URL', () => {
    const secretUrl = 'https://abcdefghijkl.supabase.co';
    try {
      buildLocalEnvContent({ API_URL: secretUrl });
      expect.fail('Should have thrown error');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toBe('Non-loopback Supabase endpoint rejected.');
      expect(msg).not.toContain(secretUrl);
      expect(msg).not.toContain('abcdefghijkl');
    }
  });

  it('4. validateAllowedOutputPath allows default path and OS temp directory, rejects tracked repo path', () => {
    expect(() => validateAllowedOutputPath(defaultEnvPath, defaultEnvPath, repoRoot)).not.toThrow();

    const tmpPath = path.resolve(tmpDir, 'custom.env');
    expect(() => validateAllowedOutputPath(tmpPath, defaultEnvPath, repoRoot)).not.toThrow();

    const trackedRepoPath = path.resolve(repoRoot, 'apps/admin-cms/src/secret.env');
    expect(() => validateAllowedOutputPath(trackedRepoPath, defaultEnvPath, repoRoot)).toThrow(
      'Invalid output path'
    );
  });

  it('5. generateLocalEnvironmentFile refuses to overwrite existing file without force', () => {
    const testFile = path.join(tmpDir, '.env.local');
    fs.writeFileSync(testFile, 'EXISTING=true');

    const mockCli = 'API_URL="http://127.0.0.1:54321"\nANON_KEY="mock"\nSERVICE_ROLE_KEY="mock"';

    expect(() =>
      generateLocalEnvironmentFile({
        outputPath: testFile,
        force: false,
        cliOutput: mockCli,
      })
    ).toThrow('File overwrite refused');
  });

  it('6. generateLocalEnvironmentFile overwrites file when force=true', () => {
    const testFile = path.join(tmpDir, '.env.local');
    fs.writeFileSync(testFile, 'EXISTING=true');

    const mockCli = 'API_URL="http://127.0.0.1:54321"\nANON_KEY="mock_anon"\nSERVICE_ROLE_KEY="mock_service"';

    const res = generateLocalEnvironmentFile({
      outputPath: testFile,
      force: true,
      cliOutput: mockCli,
    });

    expect(res.targetPath).toBe(testFile);
    const content = fs.readFileSync(testFile, 'utf8');
    expect(content).toContain('NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321');
    expect(content).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY=mock_anon');
    expect(content).toContain('SUPABASE_SERVICE_ROLE_KEY=mock_service');
    expect(content).toMatch(/CAPSTONE_AUTH_FLOW_SECRET=[0-9a-f]{64}/);
    expect(content).not.toContain('EXISTING=true');
  });

  it('7. validateAllowedOutputPath correctly handles shared string prefix and path traversal', () => {
    // Shared prefix sibling path (strictly outside repository directory)
    const siblingPath = path.resolve(repoRoot + '-other', 'custom.env');
    expect(() => validateAllowedOutputPath(siblingPath, defaultEnvPath, repoRoot)).not.toThrow();

    // Path traversal attempting to navigate out and back into repository
    const traversalPath = path.resolve(repoRoot, 'apps/admin-cms/../../apps/admin-cms/src/test.env');
    expect(() => validateAllowedOutputPath(traversalPath, defaultEnvPath, repoRoot)).toThrow(
      'Invalid output path'
    );
  });
});
