import { SupabaseClient } from '@supabase/supabase-js';
import {
  MetadataOption,
  ProjectMetadataActionResult,
  ProjectMetadataErrorCode,
  ProjectMetadataInput,
  ProjectMetadataView,
  metadataResultMessage,
  projectMetadataInputSchema,
} from './projectMetadata';

type ProjectSnapshot = ProjectMetadataView & {
  id: string;
  scalar: { program_id: string | null; program_name: string | null; discipline: string | null; industry: string | null };
};

export interface ProjectMetadataGateway {
  loadProject(publicId: string): Promise<ProjectSnapshot | null>;
  loadOptions(): Promise<{ programs: MetadataOption[]; disciplines: MetadataOption[]; industryCategories: MetadataOption[] }>;
  updateScalar(snapshot: ProjectSnapshot, input: ProjectMetadataInput, canonical: { program: MetadataOption; disciplines: MetadataOption[]; industryCategories: MetadataOption[] }): Promise<ProjectMetadataView | 'stale'>;
  replaceDisciplines(projectId: string, disciplineIds: string[]): Promise<void>;
  replaceIndustryCategories(projectId: string, industryCategoryIds: string[]): Promise<void>;
  restore(snapshot: ProjectSnapshot): Promise<void>;
}

export interface ProjectMetadataEditorData {
  metadata: ProjectMetadataView;
  programs: MetadataOption[];
  disciplines: MetadataOption[];
  industryCategories: MetadataOption[];
}

function failure(code: ProjectMetadataErrorCode, fieldErrors?: Record<string, string[]>): ProjectMetadataActionResult {
  return { ok: false, code, message: metadataResultMessage(code), fieldErrors };
}

function validateLookupIds(input: ProjectMetadataInput, options: Awaited<ReturnType<ProjectMetadataGateway['loadOptions']>>) {
  const program = options.programs.find((option) => option.id === input.programId);
  const disciplines = input.disciplineIds.map((id) => options.disciplines.find((option) => option.id === id));
  const industryCategories = input.industryCategoryIds.map((id) => options.industryCategories.find((option) => option.id === id));
  return program && disciplines.every(Boolean) && industryCategories.every(Boolean)
    ? { program, disciplines: disciplines as MetadataOption[], industryCategories: industryCategories as MetadataOption[] }
    : null;
}

export async function loadProjectMetadataEditorData(gateway: ProjectMetadataGateway, publicId: string): Promise<ProjectMetadataEditorData | null> {
  const [metadata, options] = await Promise.all([gateway.loadProject(publicId), gateway.loadOptions()]);
  return metadata ? { metadata, ...options } : null;
}

/**
 * Coordinates a deliberately narrow metadata update. The current schema has no metadata RPC,
 * so completed REST writes are compensated from a snapshot when a later stage fails.
 */
export async function saveProjectMetadata(gateway: ProjectMetadataGateway, rawInput: unknown): Promise<ProjectMetadataActionResult> {
  const parsed = projectMetadataInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return failure('VALIDATION_FAILED', parsed.error.flatten().fieldErrors);
  }

  const input = parsed.data;
  let snapshot: ProjectSnapshot | null;
  try {
    snapshot = await gateway.loadProject(input.publicId);
  } catch {
    return failure('INTERNAL_FAILURE');
  }
  if (!snapshot) return failure('PROJECT_NOT_FOUND');

  let options: Awaited<ReturnType<ProjectMetadataGateway['loadOptions']>>;
  try {
    options = await gateway.loadOptions();
  } catch {
    return failure('INTERNAL_FAILURE');
  }
  const canonical = validateLookupIds(input, options);
  if (!canonical) return failure('VALIDATION_FAILED', { programId: ['Select a supported option.'] });

  let scalarUpdated = false;
  try {
    const updated = await gateway.updateScalar(snapshot, input, canonical);
    if (updated === 'stale') return failure('STALE_VERSION');
    scalarUpdated = true;
    await gateway.replaceDisciplines(snapshot.id, input.disciplineIds);
    await gateway.replaceIndustryCategories(snapshot.id, input.industryCategoryIds);
    return { ok: true, metadata: updated };
  } catch (error) {
    console.error('[Project metadata persistence failure]', error instanceof Error ? error.message : 'unknown');
    if (!scalarUpdated) return failure('PERSISTENCE_FAILED');
    try {
      await gateway.restore(snapshot);
      return failure('PERSISTENCE_FAILED');
    } catch (rollbackError) {
      console.error('[Project metadata rollback failure]', rollbackError instanceof Error ? rollbackError.message : 'unknown');
      return failure('ROLLBACK_FAILED');
    }
  }
}

export class SupabaseProjectMetadataGateway implements ProjectMetadataGateway {
  constructor(private readonly supabase: SupabaseClient) {}

  async loadOptions() {
    const [programs, disciplines, industryCategories] = await Promise.all([
      this.supabase.from('programs').select('id, name').order('name'),
      this.supabase.from('disciplines').select('id, name').order('name'),
      this.supabase.from('industry_categories').select('id, name').order('name'),
    ]);
    if (programs.error || disciplines.error || industryCategories.error) throw new Error('Lookup load failed');
    return { programs: programs.data || [], disciplines: disciplines.data || [], industryCategories: industryCategories.data || [] };
  }

  async loadProject(publicId: string): Promise<ProjectSnapshot | null> {
    const { data, error } = await this.supabase.from('projects').select(
      'id, public_id, title, summary, background, solution, year, program_id, program_name, discipline, industry, updated_at, project_disciplines(discipline_id), project_industry_categories(industry_category_id)',
    ).eq('public_id', publicId).is('deleted_at', null).maybeSingle();
    if (error) throw new Error('Project load failed');
    if (!data) return null;
    return {
      id: data.id,
      publicId: data.public_id,
      title: data.title || '', summary: data.summary || '', background: data.background || '', solution: data.solution || '', year: String(data.year || ''),
      programId: data.program_id || '',
      disciplineIds: (data.project_disciplines || []).map((row: { discipline_id: string }) => row.discipline_id),
      industryCategoryIds: (data.project_industry_categories || []).map((row: { industry_category_id: string }) => row.industry_category_id),
      expectedUpdatedAt: data.updated_at,
      scalar: { program_id: data.program_id, program_name: data.program_name, discipline: data.discipline, industry: data.industry },
    };
  }

  async updateScalar(snapshot: ProjectSnapshot, input: ProjectMetadataInput, canonical: { program: MetadataOption; disciplines: MetadataOption[]; industryCategories: MetadataOption[] }) {
    const { data, error } = await this.supabase.from('projects').update({
      title: input.title, summary: input.summary, background: input.background, solution: input.solution, year: input.year,
      program_id: canonical.program.id, program_name: canonical.program.name,
      discipline: canonical.disciplines[0].name, industry: canonical.industryCategories[0].name,
    }).eq('id', snapshot.id).eq('updated_at', input.expectedUpdatedAt).select('updated_at').maybeSingle();
    if (error) throw new Error('Scalar update failed');
    if (!data) return 'stale' as const;
    return { ...input, year: String(input.year), expectedUpdatedAt: data.updated_at };
  }

  async replaceDisciplines(projectId: string, disciplineIds: string[]) {
    const { error: deleteError } = await this.supabase.from('project_disciplines').delete().eq('project_id', projectId);
    if (deleteError) throw new Error('Discipline delete failed');
    const { error: insertError } = await this.supabase.from('project_disciplines').insert(disciplineIds.map((discipline_id) => ({ project_id: projectId, discipline_id })));
    if (insertError) throw new Error('Discipline insert failed');
  }

  async replaceIndustryCategories(projectId: string, industryCategoryIds: string[]) {
    const { error: deleteError } = await this.supabase.from('project_industry_categories').delete().eq('project_id', projectId);
    if (deleteError) throw new Error('Industry-category delete failed');
    const { error: insertError } = await this.supabase.from('project_industry_categories').insert(industryCategoryIds.map((industry_category_id) => ({ project_id: projectId, industry_category_id })));
    if (insertError) throw new Error('Industry-category insert failed');
  }

  async restore(snapshot: ProjectSnapshot) {
    const { error: scalarError } = await this.supabase.from('projects').update({
      title: snapshot.title, summary: snapshot.summary, background: snapshot.background, solution: snapshot.solution, year: Number(snapshot.year),
      program_id: snapshot.scalar.program_id, program_name: snapshot.scalar.program_name, discipline: snapshot.scalar.discipline, industry: snapshot.scalar.industry,
    }).eq('id', snapshot.id);
    if (scalarError) throw new Error('Scalar rollback failed');
    await this.replaceDisciplines(snapshot.id, snapshot.disciplineIds);
    await this.replaceIndustryCategories(snapshot.id, snapshot.industryCategoryIds);
  }
}
