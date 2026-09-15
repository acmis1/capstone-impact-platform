import { z } from 'zod';
import type { AdminPermission } from '../auth/authTypes';
import { canManageTaxonomy } from '../auth/permissions';
import {
  layoutRecipeNameSchema,
  resolvedLayoutConfigSchema,
  type ResolvedLayoutConfig,
} from '../domain/layoutConfig';

export type LayoutRecipeStatus = 'active' | 'superseded' | 'retired';

export interface LayoutRecipeVersion {
  id: string;
  recipeId: string;
  version: number;
  name: string;
  config: ResolvedLayoutConfig;
  status: LayoutRecipeStatus;
  sourceVersionId: string | null;
  createdAt: string;
}

export type LayoutRecipeCommandCode =
  | 'CREATED'
  | 'DUPLICATED'
  | 'VERSIONED'
  | 'RETIRED'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'DUPLICATE_NAME'
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND'
  | 'PERSISTENCE_FAILED';

export type LayoutRecipeCommandResult =
  | { ok: true; code: 'CREATED' | 'DUPLICATED' | 'VERSIONED' | 'RETIRED'; recipeVersionId: string }
  | { ok: false; code: Exclude<LayoutRecipeCommandCode, 'CREATED' | 'DUPLICATED' | 'VERSIONED' | 'RETIRED'>; message: string };

const versionReferenceSchema = z.object({
  sourceVersionId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
}).strict();

export const createRecipeInputSchema = z.object({
  action: z.literal('create'),
  name: layoutRecipeNameSchema,
  config: resolvedLayoutConfigSchema,
}).strict();

export const duplicateRecipeInputSchema = z.object({
  action: z.literal('duplicate'),
  name: layoutRecipeNameSchema,
  sourceVersionId: z.string().uuid(),
}).strict();

export const versionRecipeInputSchema = versionReferenceSchema.extend({
  action: z.literal('version'),
  name: layoutRecipeNameSchema,
  config: resolvedLayoutConfigSchema,
}).strict();

export const retireRecipeInputSchema = versionReferenceSchema.extend({
  action: z.literal('retire'),
}).strict();

export type VersionRecipeInput = z.infer<typeof versionRecipeInputSchema>;

export interface LayoutRecipeGatewayResult {
  resultCode: Exclude<LayoutRecipeCommandCode, 'PERSISTENCE_FAILED'>;
  recipeVersionId?: string;
}

export interface LayoutRecipeGateway {
  create(actorAdminId: string, name: string, config: ResolvedLayoutConfig): Promise<LayoutRecipeGatewayResult>;
  duplicate(actorAdminId: string, name: string, sourceVersionId: string): Promise<LayoutRecipeGatewayResult>;
  version(actorAdminId: string, input: Omit<VersionRecipeInput, 'action'>): Promise<LayoutRecipeGatewayResult>;
  retire(actorAdminId: string, sourceVersionId: string, expectedVersion: number): Promise<LayoutRecipeGatewayResult>;
}

export function layoutRecipeMessage(code: Exclude<LayoutRecipeCommandCode, 'CREATED' | 'DUPLICATED' | 'VERSIONED' | 'RETIRED'>): string {
  switch (code) {
    case 'VALIDATION_FAILED': return 'Enter a valid bounded layout recipe.';
    case 'PERMISSION_DENIED': return 'Your account cannot manage layout recipes.';
    case 'DUPLICATE_NAME': return 'An active recipe already uses that name.';
    case 'VERSION_CONFLICT': return 'This recipe changed in another session. Reload before trying again.';
    case 'NOT_FOUND': return 'The selected recipe version no longer exists.';
    case 'PERSISTENCE_FAILED': return 'The layout recipe change could not be completed. Try again.';
  }
}

function resultFromGateway(result: LayoutRecipeGatewayResult): LayoutRecipeCommandResult {
  if (result.resultCode === 'CREATED' || result.resultCode === 'DUPLICATED' || result.resultCode === 'VERSIONED' || result.resultCode === 'RETIRED') {
    if (result.recipeVersionId) return { ok: true, code: result.resultCode, recipeVersionId: result.recipeVersionId };
    return { ok: false, code: 'PERSISTENCE_FAILED', message: layoutRecipeMessage('PERSISTENCE_FAILED') };
  }
  return { ok: false, code: result.resultCode, message: layoutRecipeMessage(result.resultCode) };
}

export async function manageLayoutRecipe(params: {
  permissions: AdminPermission[];
  actorAdminId: string;
  gateway: LayoutRecipeGateway;
  input: unknown;
}): Promise<LayoutRecipeCommandResult> {
  if (!canManageTaxonomy(params.permissions)) {
    return { ok: false, code: 'PERMISSION_DENIED', message: layoutRecipeMessage('PERMISSION_DENIED') };
  }

  const action = typeof params.input === 'object' && params.input !== null && 'action' in params.input
    ? (params.input as { action?: unknown }).action
    : null;

  try {
    if (action === 'create') {
      const parsed = createRecipeInputSchema.safeParse(params.input);
      if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', message: layoutRecipeMessage('VALIDATION_FAILED') };
      return resultFromGateway(await params.gateway.create(params.actorAdminId, parsed.data.name, parsed.data.config));
    }
    if (action === 'duplicate') {
      const parsed = duplicateRecipeInputSchema.safeParse(params.input);
      if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', message: layoutRecipeMessage('VALIDATION_FAILED') };
      return resultFromGateway(await params.gateway.duplicate(params.actorAdminId, parsed.data.name, parsed.data.sourceVersionId));
    }
    if (action === 'version') {
      const parsed = versionRecipeInputSchema.safeParse(params.input);
      if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', message: layoutRecipeMessage('VALIDATION_FAILED') };
      return resultFromGateway(await params.gateway.version(params.actorAdminId, {
        sourceVersionId: parsed.data.sourceVersionId,
        expectedVersion: parsed.data.expectedVersion,
        name: parsed.data.name,
        config: parsed.data.config,
      }));
    }
    if (action === 'retire') {
      const parsed = retireRecipeInputSchema.safeParse(params.input);
      if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', message: layoutRecipeMessage('VALIDATION_FAILED') };
      return resultFromGateway(await params.gateway.retire(params.actorAdminId, parsed.data.sourceVersionId, parsed.data.expectedVersion));
    }
  } catch {
    return { ok: false, code: 'PERSISTENCE_FAILED', message: layoutRecipeMessage('PERSISTENCE_FAILED') };
  }

  return { ok: false, code: 'VALIDATION_FAILED', message: layoutRecipeMessage('VALIDATION_FAILED') };
}
