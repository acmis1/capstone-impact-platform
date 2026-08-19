import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  requireAdmin: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}));

vi.mock('../auth/requireAdmin', () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock('../lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

import Home from './page';

describe('root route entry contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('temporarily redirects to the canonical Admin entry without rendering a splash page', () => {
    const rendered = Home();

    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith('/admin');
    expect(rendered).toBeUndefined();
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
  });
});
