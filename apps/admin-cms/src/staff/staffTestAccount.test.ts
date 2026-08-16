import { describe, expect, it } from 'vitest';
import { staffTestAccountMessage, validateStaffTestAccountInput } from './staffTestAccount';

const SYNTHETIC_PASSWORD = 'SyntheticOnly!234';
const VALID = {
  fullName: 'Synthetic UAT Staff',
  email: 'uat.staff@capstone.test',
  password: SYNTHETIC_PASSWORD,
  confirmation: SYNTHETIC_PASSWORD,
  roles: ['reviewer'],
};

describe('validateStaffTestAccountInput', () => {
  it.each([
    ['Reviewer', ['reviewer']],
    ['Editor', ['editor']],
    ['Reviewer + Editor', ['reviewer', 'editor']],
  ])('accepts %s', (_label, roles) => {
    const result = validateStaffTestAccountInput({ ...VALID, roles });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data.roles).toEqual(roles);
  });

  it.each([
    ['Administrator', ['admin']],
    ['Administrator + Editor', ['admin', 'editor']],
    ['unknown role', ['superuser']],
    ['malformed role', ['Reviewer']],
    ['empty role set', []],
  ])('rejects %s', (_label, roles) => {
    expect(validateStaffTestAccountInput({ ...VALID, roles })).toMatchObject({
      valid: false,
      field: 'roles',
    });
  });

  it.each([
    ['empty password', '', '', 'password'],
    ['short password', 'Short!123', 'Short!123', 'password'],
    ['long password', 'x'.repeat(129), 'x'.repeat(129), 'password'],
    ['mismatched confirmation', SYNTHETIC_PASSWORD, 'SyntheticOnly!999', 'password'],
  ])('rejects %s', (_label, password, confirmation, field) => {
    expect(validateStaffTestAccountInput({ ...VALID, password, confirmation })).toMatchObject({
      valid: false,
      field,
    });
  });

  it('accepts a valid password and confirmation using the shared password policy', () => {
    expect(validateStaffTestAccountInput(VALID).valid).toBe(true);
  });

  it('normalizes only the established name and email fields', () => {
    const result = validateStaffTestAccountInput({
      ...VALID,
      fullName: '  Synthetic UAT Staff  ',
      email: '  UAT.Staff@Capstone.TEST ',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.fullName).toBe('Synthetic UAT Staff');
      expect(result.data.email).toBe('uat.staff@capstone.test');
    }
  });

  it('rejects any browser-supplied internal field', () => {
    expect(
      validateStaffTestAccountInput({ ...VALID, actorAdminUserId: 'forged-actor' }),
    ).toMatchObject({ valid: false, field: 'body' });
  });

  it.each([null, [], 'body', 7, {}])('rejects malformed body %s', (body) => {
    expect(validateStaffTestAccountInput(body).valid).toBe(false);
  });
});

describe('staffTestAccountMessage', () => {
  it('returns bounded text without internal identity or provider detail', () => {
    for (const code of [
      'ACCOUNT_READY',
      'ACCOUNT_CREATION_FAILED',
      'PROVISIONING_FAILED',
      'COMPENSATION_FAILED',
      'STAGING_ONLY',
    ] as const) {
      const message = staffTestAccountMessage(code).toLowerCase();
      for (const forbidden of ['supabase', 'auth.users', 'service_role', 'uuid', 'token']) {
        expect(message).not.toContain(forbidden);
      }
    }
  });
});
