import type { StagingRuntimeEnvironment } from './stagingRuntimeIdentity';

export const PRODUCTION_ASSISTIVE_ENABLED_VAR = 'CAPSTONE_PRODUCTION_ASSISTIVE_ENABLED';
export const PRODUCTION_REMINDERS_ENABLED_VAR = 'CAPSTONE_PRODUCTION_REMINDERS_ENABLED';

export function isProductionAssistiveEnabled(
  env: StagingRuntimeEnvironment,
): boolean {
  return env[PRODUCTION_ASSISTIVE_ENABLED_VAR] === 'true';
}

export function isProductionRemindersEnabled(
  env: StagingRuntimeEnvironment,
): boolean {
  return env[PRODUCTION_REMINDERS_ENABLED_VAR] === 'true';
}
