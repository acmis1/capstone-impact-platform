import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isLoopbackUrl,
  parseSupabaseCliEnv,
  buildLocalEnvContent,
  generateLocalEnvironmentFile,
} from './localEnvironmentFile';

describe('Local Environment File Generator Unit Tests', () => {
  let tmpDir: string;

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

  it('3. buildLocalEnvContent rejects non-loopback URLs', () => {
    expect(() =>
      buildLocalEnvContent({ API_URL: 'https://hosted.supabase.co' })
    ).toThrow('Non-loopback Supabase URL rejected');
  });

  it('4. generateLocalEnvironmentFile refuses to overwrite existing file without force', () => {
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

  it('5. generateLocalEnvironmentFile overwrites file when force=true', () => {
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
    expect(content).not.toContain('EXISTING=true');
  });
});
