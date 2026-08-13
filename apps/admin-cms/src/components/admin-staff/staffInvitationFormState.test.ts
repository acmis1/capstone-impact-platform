import { describe, expect, it } from 'vitest';
import {
  INITIAL_STAFF_INVITATION_FORM_STATE,
  applyStaffInvitationOutcome,
  canSubmitStaffInvitation,
  staffInvitationAlertVariant,
  toggleStaffRole,
} from './staffInvitationFormState';

const READY = {
  ...INITIAL_STAFF_INVITATION_FORM_STATE,
  fullName: 'Synthetic Staff',
  email: 'staff@example.com',
  roles: ['reviewer' as const],
};

describe('canSubmitStaffInvitation', () => {
  it('permits a complete, idle form', () => {
    expect(canSubmitStaffInvitation(READY)).toBe(true);
  });

  it('blocks a second submit while one is in flight', () => {
    expect(canSubmitStaffInvitation({ ...READY, phase: 'submitting' })).toBe(false);
  });

  it.each([
    ['blank name', { fullName: '   ' }],
    ['blank email', { email: '  ' }],
    ['no roles', { roles: [] }],
  ])('blocks submission with %s', (_label, patch) => {
    expect(canSubmitStaffInvitation({ ...READY, ...patch })).toBe(false);
  });

  it('permits a retry once a previous attempt has settled', () => {
    expect(canSubmitStaffInvitation({ ...READY, phase: 'settled', resultCode: 'INVITATION_FAILED' })).toBe(true);
  });
});

describe('toggleStaffRole', () => {
  it('adds and removes without producing duplicates', () => {
    expect(toggleStaffRole([], 'reviewer')).toEqual(['reviewer']);
    expect(toggleStaffRole(['reviewer'], 'reviewer')).toEqual([]);
    expect(toggleStaffRole(['reviewer'], 'reviewer')).toEqual([]);
  });

  it('keeps roles in canonical order regardless of selection order', () => {
    expect(toggleStaffRole(toggleStaffRole(['editor'], 'admin'), 'reviewer')).toEqual([
      'admin',
      'reviewer',
      'editor',
    ]);
  });
});

describe('applyStaffInvitationOutcome', () => {
  it('clears the form only when an invitation is actually pending', () => {
    const settled = applyStaffInvitationOutcome(READY, {
      code: 'INVITATION_PENDING',
      message: 'Invitation sent.',
    });
    expect(settled).toMatchObject({ fullName: '', email: '', roles: [], phase: 'settled' });
  });

  it('preserves the entered values when the attempt did not succeed', () => {
    const settled = applyStaffInvitationOutcome(READY, {
      code: 'ALREADY_PROVISIONED',
      message: 'A staff account already exists.',
    });
    expect(settled).toMatchObject({
      fullName: 'Synthetic Staff',
      email: 'staff@example.com',
      roles: ['reviewer'],
      resultCode: 'ALREADY_PROVISIONED',
    });
  });
});

describe('staffInvitationAlertVariant', () => {
  it('treats only a pending invitation as success', () => {
    expect(staffInvitationAlertVariant('INVITATION_PENDING')).toBe('success');
    expect(staffInvitationAlertVariant('IN_PROGRESS')).toBe('warning');
    expect(staffInvitationAlertVariant('ALREADY_INVITED')).toBe('warning');
    expect(staffInvitationAlertVariant('VALIDATION_FAILED')).toBe('warning');
    expect(staffInvitationAlertVariant('COMPENSATION_FAILED')).toBe('destructive');
    expect(staffInvitationAlertVariant('PROVISIONING_FAILED')).toBe('destructive');
    expect(staffInvitationAlertVariant(null)).toBeNull();
  });
});
