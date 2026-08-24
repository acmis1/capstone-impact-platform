import { describe, expect, it } from 'vitest';
import { GET, HEAD } from './route';

describe('GET/HEAD /api/health', () => {
  it('remains a minimal always-200 liveness response distinct from readiness', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({ app: 'admin-cms', status: 'ok' });
  });

  it('supports bodyless liveness HEAD checks', async () => {
    const response = await HEAD();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.text()).toBe('');
  });
});
