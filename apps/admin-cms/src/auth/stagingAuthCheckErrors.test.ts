import { describe, it, expect } from 'vitest';
import { isMissingAuthUserIdColumnError } from './stagingAuthCheckErrors';

describe('isMissingAuthUserIdColumnError Unit Tests', () => {
  it('1. code 42703 -> true', () => {
    expect(isMissingAuthUserIdColumnError({ code: '42703' })).toBe(true);
  });

  it('2. Exact missing-column message -> true', () => {
    expect(isMissingAuthUserIdColumnError({ message: 'column "admin_users.auth_user_id" does not exist' })).toBe(true);
  });

  it('3. Exact unqualified missing-column message -> true', () => {
    expect(isMissingAuthUserIdColumnError({ message: 'column "auth_user_id" does not exist' })).toBe(true);
  });

  it('4. Permission-denied message containing auth_user_id -> false', () => {
    expect(isMissingAuthUserIdColumnError({ message: 'permission denied for column auth_user_id' })).toBe(false);
  });

  it('5. Connection-failure message containing auth_user_id -> false', () => {
    expect(isMissingAuthUserIdColumnError({ message: 'connection failed auth_user_id' })).toBe(false);
  });

  it('6. Arbitrary message containing only auth_user_id -> false', () => {
    expect(isMissingAuthUserIdColumnError({ message: 'auth_user_id' })).toBe(false);
  });

  it('7. null, undefined, string and number inputs -> false', () => {
    expect(isMissingAuthUserIdColumnError(null)).toBe(false);
    expect(isMissingAuthUserIdColumnError(undefined)).toBe(false);
    expect(isMissingAuthUserIdColumnError('column auth_user_id does not exist')).toBe(false);
    expect(isMissingAuthUserIdColumnError(123)).toBe(false);
  });
});
