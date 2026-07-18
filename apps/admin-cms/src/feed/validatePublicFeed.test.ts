import { describe, it, expect } from 'vitest';
import { validatePublicFeed } from './validatePublicFeed';
import { createMockProject } from '../test/projectFixtures';
import { compilePublicFeed } from './compilePublicFeed';

describe('validatePublicFeed', () => {
  it('considers an empty feed valid but produces a warning', () => {
    const result = validatePublicFeed([]);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('zero compiled records');
  });

  it('passes validation for a valid compiled record', () => {
    const validProject = createMockProject({ status: 'approved' });
    const compiled = compilePublicFeed([validProject]);
    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('fails validation when a forbidden internal field is present', () => {
    const validProject = createMockProject({ status: 'approved' });
    const compiled = compilePublicFeed([validProject]);
    // Manually inject a forbidden key
    (compiled[0] as unknown as Record<string, unknown>).status = 'approved';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Forbidden internal administrative field detected');
  });

  it('fails validation when an unknown field is present', () => {
    const validProject = createMockProject({ status: 'approved' });
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
      const validProject = createMockProject({ status: 'approved' });
      const compiled = compilePublicFeed([validProject]);
      delete (compiled[0] as unknown as Record<string, unknown>)[field];

      const result = validatePublicFeed(compiled);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(err => err.includes(`Missing required field: "${field}"`))).toBe(true);
    });
  });

  it('fails validation when id is not an integer', () => {
    const validProject = createMockProject({ status: 'approved' });
    const compiled = compilePublicFeed([validProject]);
    (compiled[0] as unknown as Record<string, unknown>).id = 1.5;

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('must be an integer');
  });

  it('fails validation when teamMembers is not an array', () => {
    const validProject = createMockProject({ status: 'approved' });
    const compiled = compilePublicFeed([validProject]);
    (compiled[0] as unknown as Record<string, unknown>).teamMembers = 'NotAnArray';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('must be a string array');
  });

  it('fails validation when layout template is invalid', () => {
    const validProject = createMockProject({ status: 'approved' });
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
        status: 'approved',
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

  it('creates warnings but remains valid for missing recommended accessibility/indexing fields', () => {
    const projectMissingRecommended = createMockProject({
      status: 'approved',
      background: '',
      solution: '',
      accessibilityText: '',
      posterText: '',
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
});
