import { z } from 'zod';

import { ASSISTIVE_PIPELINE_VERSION } from './persistenceContract';

export const ASSISTIVE_WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const ASSISTIVE_WORKER_FRESHNESS_SECONDS = 60;
export const ASSISTIVE_OCR_CAPABILITY = 'paddle-title/pp-ocrv6-small@3.7.0';
export const ASSISTIVE_LANGUAGE_CAPABILITY = 'languagetool/en-au@6.6';

export const assistiveWorkerHeartbeatResponseSchema = z.discriminatedUnion('resultCode', [
  z.object({
    resultCode: z.literal('HEARTBEAT_RECORDED'),
    healthState: z.enum(['READY', 'STOPPING']),
    heartbeatAt: z.iso.datetime({ offset: true }),
  }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
]);

export const assistiveWorkerAvailabilityResponseSchema = z.discriminatedUnion('resultCode', [
  z.object({
    resultCode: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    compatibleWorkerCount: z.number().int().min(0).max(100),
    latestHeartbeatAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
  z.object({ resultCode: z.literal('VALIDATION_FAILED') }).strict(),
]);

export const ASSISTIVE_WORKER_COMPATIBILITY = {
  environment: 'staging',
  pipelineVersion: ASSISTIVE_PIPELINE_VERSION,
  ocrCapability: ASSISTIVE_OCR_CAPABILITY,
  languageCapability: ASSISTIVE_LANGUAGE_CAPABILITY,
} as const;

export type AssistiveWorkerHealthState = 'READY' | 'STOPPING';
export type AssistiveWorkerAvailabilityResponse = z.infer<typeof assistiveWorkerAvailabilityResponseSchema>;
