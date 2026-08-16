import { describe, expect, it } from 'vitest';
import {
  INITIAL_STAFF_TEST_ACCOUNT_FORM_STATE,
  applyStaffTestAccountOutcome,
  canSubmitStaffTestAccount,
  staffTestAccountAlertVariant,
  toggleStaffTestAccountRole,
} from './staffTestAccountFormState';

const READY = {
  ...INITIAL_STAFF_TEST_ACCOUNT_FORM_STATE,
  fullName: 'Synthetic UAT Staff',
  email: 'uat.staff@capstone.test',
  password: 'SyntheticOnly!234',
  confirmation: 'SyntheticOnly!234',
  roles: ['reviewer' as const],
};

describe('staff test account form state', () => {
  it('submits only a complete valid idle form', () => {
    expect(canSubmitStaffTestAccount(READY)).toBe(true);
    expect(canSubmitStaffTestAccount({ ...READY, phase: 'submitting' })).toBe(false);
    expect(canSubmitStaffTestAccount({ ...READY, confirmation: 'SyntheticOnly!999' })).toBe(false);
    expect(canSubmitStaffTestAccount({ ...READY, roles: [] })).toBe(false);
  });

  it('toggles only direct-account roles in canonical order', () => {
    expect(toggleStaffTestAccountRole([], 'editor')).toEqual(['editor']);
    expect(toggleStaffTestAccountRole(['editor'], 'reviewer')).toEqual(['reviewer', 'editor']);
    expect(toggleStaffTestAccountRole(['reviewer'], 'reviewer')).toEqual([]);
  });

  it('clears all fields after success and always clears credential fields after failure', () => {
    expect(
      applyStaffTestAccountOutcome(READY, { code: 'ACCOUNT_READY', message: 'Ready.' }),
    ).toMatchObject({ fullName: '', email: '', password: '', confirmation: '', roles: [] });

    expect(
      applyStaffTestAccountOutcome(READY, {
        code: 'ACCOUNT_CREATION_FAILED',
        message: 'Not created.',
      }),
    ).toMatchObject({
      fullName: READY.fullName,
      email: READY.email,
      password: '',
      confirmation: '',
      roles: READY.roles,
    });
  });

  it('uses success only for ACCOUNT_READY', () => {
    expect(staffTestAccountAlertVariant('ACCOUNT_READY')).toBe('success');
    expect(staffTestAccountAlertVariant('VALIDATION_FAILED')).toBe('warning');
    expect(staffTestAccountAlertVariant('COMPENSATION_FAILED')).toBe('destructive');
  });
});
