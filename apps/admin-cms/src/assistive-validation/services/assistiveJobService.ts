import { z } from 'zod';

import {
  assistiveEnqueueResponseSchema,
  assistiveHealthResponseSchema,
  assistiveMutationResponseSchema,
  assistiveStatusResponseSchema,
} from '../domain/jobContract';
import {
  ASSISTIVE_PIPELINE_VERSION,
  assistiveInputHashSchema,
  assistivePipelineVersionSchema,
  postgresCanonicalUuidSchema,
} from '../domain/persistenceContract';
import type { AssistiveJobGateway } from '../repositories/assistiveJobRepository';
import type { AssistiveInputGateway } from '../repositories/assistiveInputRepository';
import { loadAssistiveInput } from './assistiveInputService';

const uuid = z.uuid();

export async function enqueueAssistiveValidation(
  gateway: AssistiveJobGateway,
  inputGateway: AssistiveInputGateway,
  input: {
    projectId: string;
    actorAdminUserId: string;
    privateBucket: string;
    pipelineVersion?: string;
    expectedInputHash?: string;
    expectedProjectPublicId?: string;
  },
) {
  const parsed = z.object({
    projectId: postgresCanonicalUuidSchema,
    actorAdminUserId: uuid,
    privateBucket: z.string().min(1).max(100),
    pipelineVersion: assistivePipelineVersionSchema.default(ASSISTIVE_PIPELINE_VERSION),
    expectedInputHash: assistiveInputHashSchema.optional(),
    expectedProjectPublicId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
  }).strict().safeParse(input);
  if (!parsed.success) return { resultCode: 'VALIDATION_FAILED' as const };
  try {
    const snapshot = await loadAssistiveInput(inputGateway, parsed.data.projectId, parsed.data.privateBucket);
    if (!snapshot) {
      if (parsed.data.expectedProjectPublicId !== undefined) {
        const currentProject = await inputGateway.loadProject(parsed.data.projectId);
        if (!currentProject
          || currentProject.id !== parsed.data.projectId
          || currentProject.public_id !== parsed.data.expectedProjectPublicId) {
          return { resultCode: 'PROJECT_NOT_FOUND' as const };
        }
      }
      return { resultCode: 'MEDIA_INVALID' as const };
    }
    if (parsed.data.expectedProjectPublicId !== undefined
      && (snapshot.projectId !== parsed.data.projectId
        || snapshot.currentProject.publicId !== parsed.data.expectedProjectPublicId)) {
      return { resultCode: 'PROJECT_NOT_FOUND' as const };
    }
    if (parsed.data.expectedInputHash !== undefined && snapshot.inputHash !== parsed.data.expectedInputHash) {
      return { resultCode: 'INPUT_CHANGED' as const };
    }
    return assistiveEnqueueResponseSchema.parse(await gateway.enqueue(
      parsed.data.projectId,
      parsed.data.actorAdminUserId,
      assistiveInputHashSchema.parse(snapshot.inputHash),
      parsed.data.pipelineVersion,
    ));
  } catch {
    return { resultCode: 'INTERNAL_FAILURE' as const };
  }
}

export async function getAssistiveValidationStatus(gateway: AssistiveJobGateway, runId: string) {
  const parsed = uuid.safeParse(runId);
  if (!parsed.success) return { resultCode: 'VALIDATION_FAILED' as const };
  try {
    return assistiveStatusResponseSchema.parse(await gateway.status(parsed.data));
  } catch {
    return { resultCode: 'INTERNAL_FAILURE' as const };
  }
}

export async function cancelAssistiveValidation(
  gateway: AssistiveJobGateway,
  runId: string,
  actorAdminUserId: string,
) {
  const parsed = z.object({ runId: uuid, actorAdminUserId: uuid }).safeParse({ runId, actorAdminUserId });
  if (!parsed.success) return { resultCode: 'VALIDATION_FAILED' as const };
  try {
    return assistiveMutationResponseSchema.parse(await gateway.cancel(
      parsed.data.runId,
      parsed.data.actorAdminUserId,
    ));
  } catch {
    return { resultCode: 'INTERNAL_FAILURE' as const };
  }
}

export async function getAssistiveWorkerHealth(gateway: AssistiveJobGateway) {
  try {
    return assistiveHealthResponseSchema.parse(await gateway.health());
  } catch {
    return { resultCode: 'UNHEALTHY' as const };
  }
}
