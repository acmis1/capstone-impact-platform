import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveLayoutConfigByValue, type ResolvedLayoutConfig } from '../domain/layoutConfig';
import type {
  LayoutRecipeGateway,
  LayoutRecipeGatewayResult,
  LayoutRecipeStatus,
  LayoutRecipeVersion,
  VersionRecipeInput,
} from './layoutRecipes';

type RecipeRow = {
  id: string;
  recipe_id: string;
  version: number;
  name: string;
  layout_config: unknown;
  status: LayoutRecipeStatus;
  source_version_id: string | null;
  created_at: string;
};

function rpcResult(data: unknown, error: unknown): LayoutRecipeGatewayResult {
  if (error || typeof data !== 'object' || data === null || !('resultCode' in data)) {
    throw new Error('Layout recipe persistence failed');
  }
  const result = data as { resultCode: LayoutRecipeGatewayResult['resultCode']; recipeVersionId?: string };
  return { resultCode: result.resultCode, ...(result.recipeVersionId ? { recipeVersionId: result.recipeVersionId } : {}) };
}

export class SupabaseLayoutRecipeGateway implements LayoutRecipeGateway {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(): Promise<LayoutRecipeVersion[]> {
    const { data, error } = await this.supabase
      .from('layout_recipe_versions')
      .select('id, recipe_id, version, name, layout_config, status, source_version_id, created_at')
      .order('name')
      .order('version', { ascending: false });
    if (error) throw new Error('Layout recipe list failed');
    return ((data ?? []) as RecipeRow[]).map((row) => ({
      id: row.id,
      recipeId: row.recipe_id,
      version: row.version,
      name: row.name,
      config: resolveLayoutConfigByValue(row.layout_config),
      status: row.status,
      sourceVersionId: row.source_version_id,
      createdAt: row.created_at,
    }));
  }

  async create(actorAdminId: string, name: string, config: ResolvedLayoutConfig): Promise<LayoutRecipeGatewayResult> {
    const { data, error } = await this.supabase.rpc('create_layout_recipe', {
      p_actor_admin_id: actorAdminId, p_name: name, p_layout_config: config, p_source_version_id: null,
    });
    return rpcResult(data, error);
  }

  async duplicate(actorAdminId: string, name: string, sourceVersionId: string): Promise<LayoutRecipeGatewayResult> {
    const { data, error } = await this.supabase.rpc('create_layout_recipe', {
      p_actor_admin_id: actorAdminId, p_name: name, p_layout_config: null, p_source_version_id: sourceVersionId,
    });
    return rpcResult(data, error);
  }

  async version(actorAdminId: string, input: Omit<VersionRecipeInput, 'action'>): Promise<LayoutRecipeGatewayResult> {
    const { data, error } = await this.supabase.rpc('version_layout_recipe', {
      p_actor_admin_id: actorAdminId,
      p_source_version_id: input.sourceVersionId,
      p_expected_version: input.expectedVersion,
      p_name: input.name,
      p_layout_config: input.config,
    });
    return rpcResult(data, error);
  }

  async retire(actorAdminId: string, sourceVersionId: string, expectedVersion: number): Promise<LayoutRecipeGatewayResult> {
    const { data, error } = await this.supabase.rpc('retire_layout_recipe', {
      p_actor_admin_id: actorAdminId, p_recipe_version_id: sourceVersionId, p_expected_version: expectedVersion,
    });
    return rpcResult(data, error);
  }
}
