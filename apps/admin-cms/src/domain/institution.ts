/** Approved project organisation, shared by staff-facing authentication pages. */
export const INSTITUTION_NAME = 'RMIT University Vietnam';
export const SCHOOL_NAME = 'School of Science, Engineering and Technology';
export const SCHOOL_ABBREVIATION = 'SSET';
export type RuntimeDisplayEnvironment = 'staging' | 'production' | 'local' | 'unconfigured';

/** Presentation only. This does not grant publication or administrative authority. */
export function parseRuntimeDisplayEnvironment(value: unknown): RuntimeDisplayEnvironment {
  return value === 'staging' || value === 'production' || value === 'local' ? value : 'unconfigured';
}

export function runtimeEnvironmentLabel(value: RuntimeDisplayEnvironment): string {
  switch (value) {
    case 'staging': return 'Staging environment';
    case 'production': return 'Production-designated environment';
    case 'local': return 'Local development environment';
    default: return 'Environment not configured';
  }
}
