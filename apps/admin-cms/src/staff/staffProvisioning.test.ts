import { describe, expect, it } from 'vitest';
import {
  normalizeStaffEmail,
  normalizeStaffFullName,
  staffProvisioningMessage,
  validateStaffInvitationInput,
} from './staffProvisioning';
import {
  isStaffProvisioningEnabled,
  isStaffProvisioningEnabledValue,
} from './staffProvisioningEnablement';

describe('validateStaffInvitationInput', () => {
  it('normalizes email case and surrounding whitespace exactly once', () => {
    const result = validateStaffInvitationInput({
      fullName: '  Synthetic Staff  ',
      email: '  Staff@Example.COM  ',
      roles: ['reviewer'],
    });

    expect(result).toEqual({
      valid: true,
      data: { fullName: 'Synthetic Staff', email: 'staff@example.com', roles: ['reviewer'] },
    });
  });

  it('treats case and whitespace variants as the same identity', () => {
    const spaced = validateStaffInvitationInput({
      fullName: 'A',
      email: ' Staff@Example.com ',
      roles: ['editor'],
    });
    const plain = validateStaffInvitationInput({
      fullName: 'A',
      email: 'staff@example.com',
      roles: ['editor'],
    });

    expect(spaced.valid && plain.valid).toBe(true);
    if (spaced.valid && plain.valid) {
      expect(spaced.data.email).toBe(plain.data.email);
    }
  });

  it('canonicalizes roles deterministically and removes duplicates', () => {
    const result = validateStaffInvitationInput({
      fullName: 'Multi Role',
      email: 'multi@example.com',
      roles: ['editor', 'reviewer', 'editor'],
    });

    expect(result.valid && result.data.roles).toEqual(['reviewer', 'editor']);
  });

  it('produces the same canonical role order regardless of input order', () => {
    const first = validateStaffInvitationInput({
      fullName: 'A',
      email: 'a@example.com',
      roles: ['editor', 'admin', 'reviewer'],
    });
    const second = validateStaffInvitationInput({
      fullName: 'A',
      email: 'a@example.com',
      roles: ['reviewer', 'editor', 'admin'],
    });

    expect(first.valid && second.valid).toBe(true);
    if (first.valid && second.valid) {
      expect(first.data.roles).toEqual(second.data.roles);
      expect(first.data.roles).toEqual(['admin', 'reviewer', 'editor']);
    }
  });

  it.each([
    ['missing at-sign', 'staffexample.com'],
    ['missing domain dot', 'staff@example'],
    ['embedded whitespace', 'sta ff@example.com'],
    ['double at-sign', 'staff@@example.com'],
    ['empty', '   '],
  ])('rejects a %s email address', (_label, email) => {
    const result = validateStaffInvitationInput({ fullName: 'A', email, roles: ['editor'] });
    expect(result).toEqual({ valid: false, code: 'VALIDATION_FAILED', field: 'email' });
  });

  it('rejects an over-length email address', () => {
    const email = `${'a'.repeat(250)}@example.com`;
    const result = validateStaffInvitationInput({ fullName: 'A', email, roles: ['editor'] });
    expect(result).toEqual({ valid: false, code: 'VALIDATION_FAILED', field: 'email' });
  });

  it.each([
    ['blank', '   '],
    ['empty', ''],
  ])('rejects a %s full name', (_label, fullName) => {
    const result = validateStaffInvitationInput({ fullName, email: 'a@example.com', roles: ['editor'] });
    expect(result).toEqual({ valid: false, code: 'VALIDATION_FAILED', field: 'fullName' });
  });

  it('rejects an over-length full name', () => {
    const result = validateStaffInvitationInput({
      fullName: 'a'.repeat(201),
      email: 'a@example.com',
      roles: ['editor'],
    });
    expect(result).toEqual({ valid: false, code: 'VALIDATION_FAILED', field: 'fullName' });
  });

  it.each([
    ['empty', []],
    ['unknown role', ['superuser']],
    ['a recognized role plus an unknown one', ['editor', 'superuser']],
    ['a non-string role', [7]],
    ['a null role', [null]],
    ['not an array', 'editor'],
  ])('rejects %s', (_label, roles) => {
    const result = validateStaffInvitationInput({ fullName: 'A', email: 'a@example.com', roles });
    expect(result).toEqual({ valid: false, code: 'VALIDATION_FAILED', field: 'roles' });
  });

  it.each([null, undefined, 'invitation', 42, []])('rejects a non-object payload', (raw) => {
    expect(validateStaffInvitationInput(raw).valid).toBe(false);
  });

  it('never echoes an unrecognized role back to the caller', () => {
    const result = validateStaffInvitationInput({
      fullName: 'A',
      email: 'a@example.com',
      roles: ['editor', 'superuser'],
    });
    expect(JSON.stringify(result)).not.toContain('superuser');
  });
});

describe('normalization helpers', () => {
  it('lowercases and trims email consistently', () => {
    expect(normalizeStaffEmail('  Staff@Example.COM ')).toBe('staff@example.com');
  });

  it('trims but preserves internal name formatting', () => {
    expect(normalizeStaffFullName('  Ada  Lovelace  ')).toBe('Ada  Lovelace');
  });
});

describe('staffProvisioningMessage', () => {
  it('never exposes provider, SQL or identity detail', () => {
    const codes = [
      'INVITATION_PENDING',
      'ALREADY_INVITED',
      'ALREADY_PROVISIONED',
      'VALIDATION_FAILED',
      'PERMISSION_DENIED',
      'PROVISIONING_DISABLED',
      'INVITATION_FAILED',
      'PROVISIONING_FAILED',
      'COMPENSATION_FAILED',
    ] as const;

    for (const code of codes) {
      const message = staffProvisioningMessage(code);
      expect(message.length).toBeGreaterThan(0);
      for (const forbidden of ['supabase', 'postgres', 'sql', 'auth.users', 'service_role', 'token', 'uuid']) {
        expect(message.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});

describe('staff provisioning enablement', () => {
  it.each([undefined, null, '', '  ', 'false', 'TRUE ', '1', 'yes', 'enabled'])(
    'treats %s as disabled',
    (raw) => {
      expect(isStaffProvisioningEnabledValue(raw as string | undefined)).toBe(
        typeof raw === 'string' && raw.trim().toLowerCase() === 'true',
      );
    },
  );

  it('enables only on the exact opt-in value', () => {
    expect(isStaffProvisioningEnabledValue('true')).toBe(true);
    expect(isStaffProvisioningEnabledValue(' True ')).toBe(true);
    expect(isStaffProvisioningEnabledValue('false')).toBe(false);
  });

  it('fails closed when the variable is absent', () => {
    expect(isStaffProvisioningEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isStaffProvisioningEnabled({ STAFF_PROVISIONING_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('is not exposed to the browser as a public variable', () => {
    expect('NEXT_PUBLIC_STAFF_PROVISIONING_ENABLED' in process.env).toBe(false);
  });
});
