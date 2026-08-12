import { describe, expect, it } from 'vitest';
import { PROJECT_METADATA_LIMITS, projectMetadataInputSchema } from './projectMetadata';

const ids = {
  program: 'a0000000-0000-4000-8000-000000000001',
  discipline: 'b0000000-0000-4000-8000-000000000001',
  category: 'c0000000-0000-4000-8000-000000000001',
};

function validInput() {
  return { publicId: '2026-synthetic-project', title: '  Synthetic title  ', summary: '  Synthetic summary  ', background: ' Background ', solution: ' Solution ', year: '2026', programId: ids.program, disciplineIds: [ids.discipline], industryCategoryIds: [ids.category], expectedUpdatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('project metadata contract', () => {
  it('normalizes valid input', () => {
    const result = projectMetadataInputSchema.parse(validInput());
    expect(result.title).toBe('Synthetic title');
    expect(result.year).toBe(2026);
  });

  it('accepts PostgreSQL UUID-shaped lookup IDs with a zero version nibble', () => {
    const zeroVersion = 'a0000000-0000-0000-0000-000000000001';
    expect(projectMetadataInputSchema.safeParse({
      ...validInput(),
      programId: zeroVersion,
      disciplineIds: [zeroVersion],
      industryCategoryIds: [zeroVersion],
    }).success).toBe(true);
  });

  it.each([
    ['title', { title: '   ' }], ['summary', { summary: '   ' }], ['year', { year: '20x6' }], ['program UUID', { programId: 'not-a-uuid' }],
    ['duplicate discipline', { disciplineIds: [ids.discipline, ids.discipline] }], ['duplicate category', { industryCategoryIds: [ids.category, ids.category] }],
    ['empty disciplines', { disciplineIds: [] }], ['empty categories', { industryCategoryIds: [] }], ['unexpected field', { unexpected: true }],
  ])('rejects %s', (_name, patch) => expect(projectMetadataInputSchema.safeParse({ ...validInput(), ...patch }).success).toBe(false));

  it.each([
    ['title', PROJECT_METADATA_LIMITS.title], ['summary', PROJECT_METADATA_LIMITS.summary], ['background', PROJECT_METADATA_LIMITS.background], ['solution', PROJECT_METADATA_LIMITS.solution],
  ])('accepts the %s maximum and rejects one additional character', (field, maximum) => {
    const atBoundary = { ...validInput(), [field]: 'x'.repeat(maximum) };
    const overBoundary = { ...validInput(), [field]: 'x'.repeat(maximum + 1) };
    expect(projectMetadataInputSchema.safeParse(atBoundary).success).toBe(true);
    expect(projectMetadataInputSchema.safeParse(overBoundary).success).toBe(false);
  });

  it('enforces inclusive documented year boundaries', () => {
    expect(projectMetadataInputSchema.safeParse({ ...validInput(), year: String(PROJECT_METADATA_LIMITS.minimumYear) }).success).toBe(true);
    expect(projectMetadataInputSchema.safeParse({ ...validInput(), year: String(PROJECT_METADATA_LIMITS.maximumYear) }).success).toBe(true);
    expect(projectMetadataInputSchema.safeParse({ ...validInput(), year: String(PROJECT_METADATA_LIMITS.minimumYear - 1) }).success).toBe(false);
    expect(projectMetadataInputSchema.safeParse({ ...validInput(), year: String(PROJECT_METADATA_LIMITS.maximumYear + 1) }).success).toBe(false);
  });
});
