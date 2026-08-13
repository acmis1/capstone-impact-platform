import { describe, it, expect } from 'vitest';
import { validatePublicFeed } from './validatePublicFeed';
import { createMockProject } from '../test/projectFixtures';
import { compilePublicFeed } from './compilePublicFeed';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';

describe('validatePublicFeed', () => {
  it('considers an empty feed valid but produces a warning', () => {
    const result = validatePublicFeed([]);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('zero compiled records');
  });

  it('passes validation for a valid compiled record', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('fails validation when a forbidden internal field is present', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    // Manually inject a forbidden key
    (compiled[0] as unknown as Record<string, unknown>).status = 'published';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Forbidden internal administrative field detected');
  });

  it('fails validation when an unknown field is present', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    // Manually inject an unknown key
    (compiled[0] as unknown as Record<string, unknown>).unknownExtraField = 'some-value';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Unknown schema field detected');
  });

  it('fails validation when required fields are missing', () => {
    const requiredFields = [
      'id', 'publicId', 'title', 'summary', 'year', 'program', 'studyProgram',
      'discipline', 'groupName', 'teamMembers', 'poster', 'posterPdf', 'layoutConfig'
    ];

    requiredFields.forEach(field => {
      const validProject = createMockProject({ status: 'published' });
      const compiled = compilePublicFeed([validProject]);
      delete (compiled[0] as unknown as Record<string, unknown>)[field];

      const result = validatePublicFeed(compiled);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(err => err.includes(`Missing required field: "${field}"`))).toBe(true);
    });
  });

  it('fails validation when id is not an integer', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    (compiled[0] as unknown as Record<string, unknown>).id = 1.5;

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('must be an integer');
  });

  it('fails validation when teamMembers is not an array', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    (compiled[0] as unknown as Record<string, unknown>).teamMembers = 'NotAnArray';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('must be a string array');
  });

  it('fails validation when layout template is invalid', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    (compiled[0].layoutConfig as unknown as Record<string, unknown>).templateId = 'invalid_layout_type';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Layout error: "templateId" must be one of');
  });

  it('passes validation for supported templates', () => {
    const templates = ['poster_showcase', 'technical_detail', 'media_rich'];
    templates.forEach(templateId => {
      const validProject = createMockProject({
        status: 'published',
        layoutConfig: {
          templateId,
          featuredMedia: 'poster',
          sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
        },
      });
      const compiled = compilePublicFeed([validProject]);
      const result = validatePublicFeed(compiled);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });
  });

  it('creates warnings but remains valid for missing recommended indexing fields', () => {
    const projectMissingRecommended = createMockProject({
      status: 'published',
      background: '',
      solution: '',
      academicSupervisor: '',
      industryPartner: '',
      industry: '',
      disciplines: [],
    });
    const compiled = compilePublicFeed([projectMissingRecommended]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('rejects a public record whose poster full text is blank', () => {
    const compiled = compilePublicFeed([createMockProject({ status: 'published', posterText: '' })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"posterText" is empty'))).toBe(true);
  });

  it('rejects a public record whose accessibility text is blank', () => {
    const compiled = compilePublicFeed([createMockProject({ status: 'published', accessibilityText: '' })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"accessibilityText" is empty'))).toBe(true);
  });

  it('rejects a public record whose accessible content is whitespace only', () => {
    const compiled = compilePublicFeed([createMockProject({ status: 'published', posterText: '   ', accessibilityText: '\n ' })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"posterText" is empty'))).toBe(true);
    expect(result.errors.some((error) => error.includes('"accessibilityText" is empty'))).toBe(true);
  });

  it('rejects a public record whose poster full text exceeds its safety limit', () => {
    const compiled = compilePublicFeed([createMockProject({
      status: 'published',
      posterText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText + 1),
    })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"posterText" exceeds the 20,000 character safety limit'))).toBe(true);
  });

  it('rejects a public record whose accessibility text exceeds its safety limit', () => {
    const compiled = compilePublicFeed([createMockProject({
      status: 'published',
      accessibilityText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText + 1),
    })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"accessibilityText" exceeds the 2,000 character safety limit'))).toBe(true);
  });

  it('accepts a public record with accessible content exactly at each ceiling', () => {
    const compiled = compilePublicFeed([createMockProject({
      status: 'published',
      posterText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText),
      accessibilityText: 'y'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText),
    })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // Nothing is truncated to make the record valid.
    expect(compiled[0].posterText).toHaveLength(ACCESSIBLE_CONTENT_LIMITS.posterText);
  });

  it('accepts a public record carrying both accessible content values', () => {
    const compiled = compilePublicFeed([createMockProject({
      status: 'published',
      posterText: 'Full textual version of every meaningful heading, figure caption, and body paragraph on the poster.',
      accessibilityText: 'Research poster showing three turbine layout diagrams beside a results table.',
    })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(compiled[0].posterText).toContain('Full textual version');
    expect(compiled[0].accessibilityText).toContain('Research poster showing');
  });
});
