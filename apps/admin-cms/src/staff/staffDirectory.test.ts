import { describe, expect, it, vi } from 'vitest';
import { readStaffDirectory } from './staffDirectory';

describe('readStaffDirectory', () => {
  it('surfaces an in-progress compensation lifecycle without internal identifiers', async () => {
    const client = {
      from: vi.fn((table: string) => ({
        select: vi.fn().mockResolvedValue(
          table === 'admin_users'
            ? { data: [], error: null }
            : table === 'user_roles'
              ? { data: [], error: null }
              : {
                data: [{
                  admin_user_id: 'internal-profile-id',
                  normalized_email: 'cleanup@capstone.test',
                  full_name: 'Cleanup Pending',
                  requested_roles: ['reviewer'],
                  status: 'compensating',
                  failure_code: null,
                  created_at: '2026-08-13T12:00:00.000Z',
                }],
                error: null,
              },
        ),
      })),
    };

    const directory = await readStaffDirectory(client as never);

    expect(directory).toEqual({
      staff: [],
      incidents: [{
        fullName: 'Cleanup Pending',
        email: 'cleanup@capstone.test',
        roles: ['reviewer'],
        status: 'compensating',
        failureCode: null,
        requestedAt: '2026-08-13T12:00:00.000Z',
      }],
    });
    expect(JSON.stringify(directory)).not.toContain('internal-profile-id');
  });
});
