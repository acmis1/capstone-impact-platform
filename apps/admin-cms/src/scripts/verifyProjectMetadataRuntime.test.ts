import { describe, expect, it } from 'vitest';
import {
  assertRuntimeCleanup,
  assertRuntimePrivilegeResults,
  evaluateConcurrentSaveResults,
} from './verifyProjectMetadataRuntime';

describe('project metadata runtime verifier result contracts', () => {
  const success = { data: { resultCode: 'SUCCESS' }, error: null };
  const stale = { data: { resultCode: 'STALE_VERSION' }, error: null };

  it('requires exactly one successful and one stale result for a concurrent save', () => {
    expect(evaluateConcurrentSaveResults([success, stale])).toMatchObject({ successCount: 1, staleVersionCount: 1 });
    expect(() => evaluateConcurrentSaveResults([success, success])).toThrow('exactly one SUCCESS and one STALE_VERSION');
    expect(() => evaluateConcurrentSaveResults([success, stale, stale])).toThrow('exactly one SUCCESS and one STALE_VERSION');
  });

  it('requires service-role success and both forbidden runtime role denials', () => {
    expect(() => assertRuntimePrivilegeResults({ serviceRole: success, anonDenied: true, authenticatedDenied: true })).not.toThrow();
    expect(() => assertRuntimePrivilegeResults({ serviceRole: { data: null, error: { message: 'denied' } }, anonDenied: true, authenticatedDenied: true })).toThrow('Service-role');
    expect(() => assertRuntimePrivilegeResults({ serviceRole: success, anonDenied: false, authenticatedDenied: true })).toThrow('Forbidden runtime role');
    expect(() => assertRuntimePrivilegeResults({ serviceRole: success, anonDenied: true, authenticatedDenied: false })).toThrow('Forbidden runtime role');
  });

  it('treats any synthetic fixture or temporary object left behind as cleanup failure', () => {
    expect(() => assertRuntimeCleanup({ syntheticProjectCount: 0, temporaryTriggerCount: 0, temporaryFunctionCount: 0 })).not.toThrow();
    expect(() => assertRuntimeCleanup({ syntheticProjectCount: 1, temporaryTriggerCount: 0, temporaryFunctionCount: 0 })).toThrow('cleanup left');
    expect(() => assertRuntimeCleanup({ syntheticProjectCount: 0, temporaryTriggerCount: 1, temporaryFunctionCount: 0 })).toThrow('cleanup left');
    expect(() => assertRuntimeCleanup({ syntheticProjectCount: 0, temporaryTriggerCount: 0, temporaryFunctionCount: 1 })).toThrow('cleanup left');
  });
});
