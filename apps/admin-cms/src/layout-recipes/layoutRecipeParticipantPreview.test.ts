import { describe, expect, it } from 'vitest';
import { createLayoutConfigFromStock, LAYOUT_TEMPLATE_IDS } from '../domain/layoutConfig';
import type { ParticipantPreviewMediaViewRef, ParticipantPreviewSnapshot } from '../domain/participantPreview';
import { ParticipantPreviewEvidenceError, renderParticipantPreviewPage } from '../previews/participantPreviewHtml';

const baseSnapshot: ParticipantPreviewSnapshot = {
  title: 'Recipe project', summary: 'Summary', background: 'Background copy', solution: 'Solution copy',
  year: 2026, program: 'IT', studyProgram: null, discipline: 'Software engineering', disciplines: ['Software engineering'],
  industry: null, industryPartner: 'Partner', academicSupervisor: 'Supervisor', groupName: 'Team One',
  teamMembers: ['Alice', 'Bob'], posterText: 'Full poster text', accessibilityText: 'Poster description',
  citations: ['Citation'], externalLinks: [{ label: 'Reference', url: 'https://example.com/reference' }],
  industryCategories: ['Technology'], videoUrl: 'https://example.com/video', demoUrl: 'https://example.com/demo',
  repositoryUrl: 'https://example.com/repository',
};

const media: ParticipantPreviewMediaViewRef[] = [
  { mediaAssetId: 'poster', assetType: 'poster_image', galleryPosition: null, fileName: 'poster.png', mimeType: 'image/png', altText: null, signedUrl: 'https://example.com/poster.png' },
  { mediaAssetId: 'snapshot', assetType: 'snapshot_image', galleryPosition: 1, fileName: 'snapshot.png', mimeType: 'image/png', altText: 'Results screen', contentKind: 'text_bearing', fullText: 'Exact results transcript.', signedUrl: 'https://example.com/snapshot.png' },
];

function render(snapshot: ParticipantPreviewSnapshot, renderedMedia = media) {
  return renderParticipantPreviewPage({ snapshot, media: renderedMedia, responseState: { type: 'unresponded' } });
}

describe('recipe-backed participant preview composition', () => {
  it.each(LAYOUT_TEMPLATE_IDS)('renders the complete %s stock value with mandatory snapshot text', (templateId) => {
    const stockConfig = createLayoutConfigFromStock(templateId);
    const html = render({ ...baseSnapshot, layoutConfig: stockConfig });

    expect(html).toContain(`data-layout-section="${stockConfig.featuredMedia}" data-layout-featured="true"`);
    expect(html).toContain('data-layout-section="snapshots"');
    expect(html).toContain('Exact results transcript.');
  });

  it('renders the captured value order, safe visibility and featured media without a recipe lookup', () => {
    const html = render({
      ...baseSnapshot,
      layoutConfig: {
        templateId: 'technical_detail', featuredMedia: 'snapshots',
        sectionOrder: ['team', 'background', 'solution', 'snapshots', 'video', 'links', 'citations', 'accessibilityText'],
        hiddenSections: ['solution', 'video'],
      },
    });

    expect(html).toContain('data-layout-section="snapshots" data-layout-featured="true"');
    expect(html.indexOf('data-layout-section="team"')).toBeLessThan(html.indexOf('data-layout-section="background"'));
    expect(html).not.toContain('data-layout-section="solution"');
    expect(html).not.toContain('data-layout-section="video"');
    expect(html).toContain('data-layout-section="accessibilityText"');
    expect(html).toContain('Poster Full Text');
    expect(html).toContain('Exact results transcript.');
    expect(html).not.toContain('recipeVersionId');
  });

  it('falls back to available media and rejects recipe evidence that hides snapshots', () => {
    const noSnapshots = render({
      ...baseSnapshot,
      layoutConfig: {
        templateId: 'media_rich', featuredMedia: 'snapshots',
        sectionOrder: ['background', 'solution', 'snapshots', 'video', 'team', 'links', 'citations', 'accessibilityText'],
        hiddenSections: [],
      },
    }, media.filter((item) => item.assetType !== 'snapshot_image'));
    expect(noSnapshots).toContain('data-layout-section="video" data-layout-featured="true"');

    expect(() => render({
      ...baseSnapshot,
      layoutConfig: {
        templateId: 'poster_showcase', featuredMedia: 'poster',
        sectionOrder: ['background', 'solution', 'snapshots', 'video', 'team', 'links', 'citations', 'accessibilityText'],
        hiddenSections: ['snapshots'] as never,
      },
    })).toThrow(ParticipantPreviewEvidenceError);
  });

  it('keeps historical previews on the legacy composition and fails closed on malformed new evidence', () => {
    const historical = render(baseSnapshot);
    expect(historical).toContain('Project overview');
    expect(historical).not.toContain('data-layout-featured');

    expect(() => render({
      ...baseSnapshot,
      layoutConfig: {
        templateId: 'poster_showcase', featuredMedia: 'poster',
        sectionOrder: ['team', 'team'] as never,
        hiddenSections: [],
      },
    })).toThrow(ParticipantPreviewEvidenceError);
  });
});
