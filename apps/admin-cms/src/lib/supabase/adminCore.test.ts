import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn((url: string) => ({ url })),
  getServerEnv: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('../env', () => ({ getServerEnv: mocks.getServerEnv }));

import {
  createSupabaseAdminClientCore,
  createSupabaseAdminClientCoreForServerEnv,
} from './adminCore';

describe('Supabase administrator client target binding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not reuse a cached target A client for a resolved target B environment', () => {
    const targetA = {
      supabaseUrl: 'https://synthetic-target-a.supabase.co',
      supabaseDatabaseAdminKey: 'synthetic-secret-a',
    };
    const targetB = {
      supabaseUrl: 'https://synthetic-target-b.supabase.co',
      supabaseDatabaseAdminKey: 'synthetic-secret-b',
    };
    mocks.getServerEnv.mockReturnValue(targetA);

    const cachedA = createSupabaseAdminClientCore();
    mocks.getServerEnv.mockReturnValue(targetB);
    expect(createSupabaseAdminClientCore()).toBe(cachedA);

    const boundB = createSupabaseAdminClientCoreForServerEnv(targetB);
    expect(boundB).not.toBe(cachedA);
    expect(mocks.createClient.mock.calls.map(([url]) => url)).toEqual([
      targetA.supabaseUrl,
      targetB.supabaseUrl,
    ]);
  });
});
