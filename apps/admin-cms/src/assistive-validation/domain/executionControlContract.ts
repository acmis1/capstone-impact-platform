import { z } from 'zod';

/**
 * Execution-control contract for the zero-cost on-demand assistive executor.
 *
 * Cost authority is a rolling window, not a calendar month: the provider documents its free grant
 * as "per calendar month" but does not document the reset timezone or instant, so a calendar reset
 * cannot be the hard fence. Any calendar month is at most 31 days, so bounding every rolling
 * 31-day interval also bounds every calendar month regardless of the provider's reset boundary.
 *
 * These values mirror the equality constraints in Migration 0047. They are not configuration:
 * raising either requires a new reviewed forward migration.
 */
export const LAUNCH_LIMIT_PER_ROLLING_WINDOW = 40;
export const LAUNCH_WINDOW_DAYS = 31;
export const MAX_ACTIVE_HEAVY_EXECUTIONS = 1;

/** Reservation fence window. Must exceed the heavy-job replica timeout plus its start latency. */
export const RESERVATION_TTL_SECONDS = 900;

/** Wall-clock drain budget, leaving headroom inside the 600-second heavy replica timeout. */
export const ON_DEMAND_RUNTIME_BUDGET_MS = 480_000;

/** How long an operator registration stays valid before it must be republished. */
export const EXECUTOR_REGISTRATION_DAYS = 30;

export const ASSISTIVE_EXECUTION_MODES = ['CONTINUOUS', 'ON_DEMAND'] as const;
export type AssistiveExecutionMode = (typeof ASSISTIVE_EXECUTION_MODES)[number];

export const deploymentVersionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const executorInstanceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const configurationVersionSchema = z.string().regex(/^[a-z0-9][a-z0-9./-]{0,63}$/);

const budgetFields = {
  launchLimit: z.number().int().min(1).max(LAUNCH_LIMIT_PER_ROLLING_WINDOW),
  windowDays: z.number().int().min(1).max(LAUNCH_WINDOW_DAYS),
  consumedInWindow: z.number().int().min(0),
};

// The bare form is returned only when the guard row itself is absent, so the two branches share a
// result code and cannot be discriminated on it.
export const launchEligibilityResponseSchema = z.union([
  z.object({
    resultCode: z.enum([
      'WORK_AVAILABLE', 'NO_WORK', 'BUDGET_EXHAUSTED', 'ACTIVE_LAUNCH', 'EXECUTOR_UNREGISTERED',
    ]),
    ...budgetFields,
    activeExecutions: z.number().int().min(0),
  }).strict(),
  z.object({ resultCode: z.literal('EXECUTOR_UNREGISTERED') }).strict(),
]);

export const launchReservationResponseSchema = z.union([
  z.object({
    resultCode: z.literal('RESERVED'),
    reservationToken: z.uuid(),
    generation: z.number().int().positive(),
    ...budgetFields,
    expiresAt: z.string().min(1),
  }).strict(),
  z.object({
    resultCode: z.literal('BUDGET_EXHAUSTED'),
    ...budgetFields,
  }).strict(),
  z.object({
    resultCode: z.literal('ACTIVE_LAUNCH'),
    activeExecutions: z.number().int().min(0),
  }).strict(),
  z.object({
    resultCode: z.enum(['NO_WORK', 'EXECUTOR_UNREGISTERED', 'VALIDATION_FAILED']),
  }).strict(),
]);

export const launchRequestedResponseSchema = z.object({
  resultCode: z.enum(['START_REQUESTED', 'FENCED', 'VALIDATION_FAILED']),
}).strict();

export const launchOutcomeResponseSchema = z.union([
  z.object({
    resultCode: z.literal('OUTCOME_RECORDED'),
    state: z.string().min(1),
  }).strict(),
  z.object({ resultCode: z.enum(['FENCED', 'VALIDATION_FAILED']) }).strict(),
]);

export const executionClaimResponseSchema = z.union([
  z.object({
    resultCode: z.literal('CLAIMED'),
    expiresAt: z.string().min(1),
  }).strict(),
  z.object({ resultCode: z.enum(['CLAIM_REFUSED', 'VALIDATION_FAILED']) }).strict(),
]);

export const executionSettlementResponseSchema = z.union([
  z.object({ resultCode: z.literal('SETTLED'), state: z.enum(['COMPLETED', 'FAILED']) }).strict(),
  z.object({ resultCode: z.enum(['FENCED', 'VALIDATION_FAILED']) }).strict(),
]);

export const executorRegistrationResponseSchema = z.union([
  z.object({
    resultCode: z.literal('REGISTERED'),
    deploymentVersion: deploymentVersionSchema,
    imageDigest: imageDigestSchema,
    expiresAt: z.string().min(1),
  }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
]);

export const executorAvailabilityResponseSchema = z.union([
  z.object({
    resultCode: z.enum(['AVAILABLE', 'UNAVAILABLE', 'BUDGET_EXHAUSTED']),
    executionMode: z.literal('ON_DEMAND'),
    ...budgetFields,
    remainingInWindow: z.number().int().min(0),
    activeExecutions: z.number().int().min(0),
    /** Reporting only. The rolling window above is the authority. */
    utcCalendarMonthStarts: z.number().int().min(0),
    lastExecutionAt: z.string().nullable(),
    registrationExpiresAt: z.string().nullable(),
  }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
]);

/**
 * Outcomes the launcher may report.
 *
 * `PRESTART_FAILED` is the only outcome that proves no start request was ever transmitted, and is
 * therefore the only one that releases the reserved unit. Everything else is reachable only after
 * transmission and keeps the unit consumed, deliberately preferring a false-positive consumption
 * over an uncounted billable execution.
 */
export const LAUNCH_OUTCOMES = [
  'PRESTART_FAILED', 'START_ACCEPTED', 'START_RESPONSE_ERROR', 'START_AMBIGUOUS',
] as const;
export type LaunchOutcome = (typeof LAUNCH_OUTCOMES)[number];

export type LaunchEligibilityResponse = z.infer<typeof launchEligibilityResponseSchema>;
export type LaunchReservationResponse = z.infer<typeof launchReservationResponseSchema>;
export type ExecutorAvailabilityResponse = z.infer<typeof executorAvailabilityResponseSchema>;

/**
 * A reservation token is a bounded execution capability. It never appears in full in logs, in the
 * Admin UI, or in reports; evidence uses this truncated form.
 */
export function redactReservationToken(token: string): string {
  return /^[0-9a-f-]{8,}$/i.test(token) ? `${token.slice(0, 8)}…` : '…';
}
