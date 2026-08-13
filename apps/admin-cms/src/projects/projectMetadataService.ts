import { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  MetadataOption,
  ProjectMetadataActionResult,
  ProjectMetadataErrorCode,
  ProjectMetadataInput,
  ProjectMetadataView,
  metadataResultMessage,
  projectMetadataInputSchema,
  postgresUuidSchema,
} from './projectMetadata';

type ProjectSnapshot = ProjectMetadataView & { id: string };
type MetadataOptions = { programs: MetadataOption[]; disciplines: MetadataOption[]; industryCategories: MetadataOption[] };

const uuidArray = z.array(postgresUuidSchema);
const metadataResponseSchema = z.object({
  publicId: z.string().min(1), title: z.string(), summary: z.string(), background: z.string(), solution: z.string(),
  year: z.string().regex(/^\d{4}$/), programId: postgresUuidSchema, disciplineIds: uuidArray, industryCategoryIds: uuidArray,
  expectedUpdatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
}).strict();
const rpcResponseSchema = z.object({
  resultCode: z.enum(['SUCCESS', 'PROJECT_NOT_FOUND', 'STALE_VERSION', 'VALIDATION_FAILED', 'APPROVAL_REOPEN_REQUIRED', 'PUBLISHED_PROJECT_LOCKED', 'PERMISSION_DENIED', 'NO_CHANGES']),
  metadata: metadataResponseSchema.optional(),
}).strict();

export interface ProjectMetadataGateway {
  loadProject(publicId: string, options?: MetadataOptions): Promise<ProjectSnapshot | null>;
  loadOptions(): Promise<MetadataOptions>;
  /** The only metadata mutation boundary: one database RPC invocation. */
  updateMetadataAtomically(input: ProjectMetadataInput, actorAdminUserId: string): Promise<unknown>;
}

export interface ProjectMetadataEditorData extends MetadataOptions { metadata: ProjectMetadataView; }

function failure(code: ProjectMetadataErrorCode, fieldErrors?: Record<string, string[]>): ProjectMetadataActionResult {
  return { ok: false, code, message: metadataResultMessage(code), fieldErrors };
}

function lookupFieldErrors(input: ProjectMetadataInput, options: MetadataOptions): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (!options.programs.some((option) => option.id === input.programId)) errors.programId = ['Select a supported program.'];
  if (input.disciplineIds.some((id) => !options.disciplines.some((option) => option.id === id))) errors.disciplineIds = ['Select supported disciplines.'];
  if (input.industryCategoryIds.some((id) => !options.industryCategories.some((option) => option.id === id))) errors.industryCategoryIds = ['Select supported industry categories.'];
  return errors;
}

export async function loadProjectMetadataEditorData(gateway: ProjectMetadataGateway, publicId: string): Promise<ProjectMetadataEditorData | null> {
  const options = await gateway.loadOptions();
  const snapshot = await gateway.loadProject(publicId, options);
  if (!snapshot) return null;

  // The database-only primary key must not cross into the strict mutation payload.
  const metadata: ProjectMetadataView = {
    publicId: snapshot.publicId,
    title: snapshot.title,
    summary: snapshot.summary,
    background: snapshot.background,
    solution: snapshot.solution,
    year: snapshot.year,
    programId: snapshot.programId,
    disciplineIds: snapshot.disciplineIds,
    industryCategoryIds: snapshot.industryCategoryIds,
    expectedUpdatedAt: snapshot.expectedUpdatedAt,
  };
  return { metadata, ...options };
}

export async function saveProjectMetadata(gateway: ProjectMetadataGateway, rawInput: unknown, actorAdminUserId: string): Promise<ProjectMetadataActionResult> {
  const parsed = projectMetadataInputSchema.safeParse(rawInput);
  if (!parsed.success) return failure('VALIDATION_FAILED', parsed.error.flatten().fieldErrors);

  const input = parsed.data;
  let options: MetadataOptions;
  try {
    options = await gateway.loadOptions();
  } catch {
    return failure('INTERNAL_FAILURE');
  }
  const fieldErrors = lookupFieldErrors(input, options);
  if (Object.keys(fieldErrors).length > 0) return failure('VALIDATION_FAILED', fieldErrors);

  let rawResponse: unknown;
  try {
    rawResponse = await gateway.updateMetadataAtomically(input, actorAdminUserId);
  } catch (error) {
    console.error('[Project metadata RPC failure]', error instanceof Error ? error.message : 'unknown');
    return failure('PERSISTENCE_FAILED');
  }

  const response = rpcResponseSchema.safeParse(rawResponse);
  if (!response.success) return failure('INTERNAL_FAILURE');
  switch (response.data.resultCode) {
    case 'SUCCESS':
      return response.data.metadata ? { ok: true, metadata: response.data.metadata } : failure('INTERNAL_FAILURE');
    case 'NO_CHANGES':
      // The input matched the database state exactly.
      return { ok: true, metadata: { ...input, year: String(input.year) } };
    case 'PROJECT_NOT_FOUND': return failure('PROJECT_NOT_FOUND');
    case 'STALE_VERSION': return failure('STALE_VERSION');
    case 'APPROVAL_REOPEN_REQUIRED': return failure('APPROVAL_REOPEN_REQUIRED');
    case 'PUBLISHED_PROJECT_LOCKED': return failure('PUBLISHED_PROJECT_LOCKED');
    case 'VALIDATION_FAILED': return failure('VALIDATION_FAILED');
    case 'PERMISSION_DENIED': return failure('PERMISSION_DENIED');
  }
}

export function resolveUniqueLookupId(options: MetadataOption[], name: string | null): string {
  if (!name) return '';
  const matches = options.filter((option) => option.name === name);
  return matches.length === 1 ? matches[0].id : '';
}

export class SupabaseProjectMetadataGateway implements ProjectMetadataGateway {
  constructor(private readonly supabase: SupabaseClient) {}

  async loadOptions(): Promise<MetadataOptions> {
    const [programs, disciplines, industryCategories] = await Promise.all([
      this.supabase.from('programs').select('id, name').order('name'),
      this.supabase.from('disciplines').select('id, name').order('name'),
      this.supabase.from('industry_categories').select('id, name').order('name'),
    ]);
    if (programs.error || disciplines.error || industryCategories.error) throw new Error('Lookup load failed');
    return { programs: programs.data || [], disciplines: disciplines.data || [], industryCategories: industryCategories.data || [] };
  }

  async loadProject(publicId: string, options?: MetadataOptions): Promise<ProjectSnapshot | null> {
    const { data, error } = await this.supabase.from('projects').select(
      'id, public_id, title, summary, background, solution, year, program_id, program_name, discipline, industry, updated_at, project_disciplines(discipline_id), project_industry_categories(industry_category_id)',
    ).eq('public_id', publicId).is('deleted_at', null).maybeSingle();
    if (error) throw new Error('Project load failed');
    if (!data) return null;
    const disciplineIds = (data.project_disciplines || []).map((row: { discipline_id: string }) => row.discipline_id);
    const industryCategoryIds = (data.project_industry_categories || []).map((row: { industry_category_id: string }) => row.industry_category_id);
    return {
      id: data.id, publicId: data.public_id, title: data.title || '', summary: data.summary || '', background: data.background || '', solution: data.solution || '',
      year: String(data.year || ''), programId: data.program_id || resolveUniqueLookupId(options?.programs || [], data.program_name),
      disciplineIds: disciplineIds.length ? disciplineIds : [resolveUniqueLookupId(options?.disciplines || [], data.discipline)].filter(Boolean),
      industryCategoryIds: industryCategoryIds.length ? industryCategoryIds : [resolveUniqueLookupId(options?.industryCategories || [], data.industry)].filter(Boolean),
      expectedUpdatedAt: data.updated_at,
    };
  }

  async updateMetadataAtomically(input: ProjectMetadataInput, actorAdminUserId: string): Promise<unknown> {
    const { data, error } = await this.supabase.rpc('update_project_metadata', {
      p_public_id: input.publicId, p_title: input.title, p_summary: input.summary, p_background: input.background, p_solution: input.solution,
      p_year: input.year, p_program_id: input.programId, p_discipline_ids: input.disciplineIds,
      p_industry_category_ids: input.industryCategoryIds, p_expected_updated_at: input.expectedUpdatedAt,
      p_admin_id: actorAdminUserId,
    });
    if (error) throw new Error('Metadata update RPC failed');
    return data;
  }
}
