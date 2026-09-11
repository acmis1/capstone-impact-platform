import { describe, it, expect, vi } from 'vitest';
import { materializeFormIntakePackage } from '../formIntakeMaterializerClient';
import {
  createInitialFormIntakeMetadata,
  createInitialFormIntakeMediaState,
} from '../formIntakeContract';

describe('formIntakeMaterializerClient', () => {
  it('enriches metadata with MG-05 gallery fields and constructs synthetic package files on success', async () => {
    const metadata = {
      ...createInitialFormIntakeMetadata(),
      publicId: 'rover-mission-2026',
      title: 'Rover Mission 2026',
      summary: 'Robotics rover telemetry and mapping.',
      program: 'Robotics Engineering',
      discipline: 'Robotics',
      year: '2026',
      groupName: 'AeroRobotics',
      teamMembers: 'Alex, Sam',
      posterText: 'Full transcript of poster',
      accessibilityText: 'Poster alt text',
    };

    const media = createInitialFormIntakeMediaState();
    media.posterImage = new File(['dummy-img'], 'poster.png', { type: 'image/png' });
    media.posterPdf = new File(['dummy-pdf'], 'poster.pdf', { type: 'application/pdf' });
    media.galleryImages[0].file = new File(['dummy-snap-1'], 'photo.png', { type: 'image/png' });
    media.galleryImages[0].altText = 'Lab testing setup';
    media.galleryImages[0].contentKind = 'ordinary';
    media.galleryImages[0].fullText = '';

    media.galleryImages[1].file = new File(['dummy-snap-2'], 'diagram.jpg', { type: 'image/jpeg' });
    media.galleryImages[1].altText = 'Block diagram';
    media.galleryImages[1].contentKind = 'text_bearing';
    media.galleryImages[1].fullText = 'Microcontroller to radio link';

    let capturedPayload: unknown = null;
    const mockBlob = new Blob(['dummy-xlsx-data'], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedPayload = JSON.parse(options.body as string);
      return {
        ok: true,
        blob: async () => mockBlob,
      } as Response;
    });

    const result = await materializeFormIntakePackage(metadata, media, { fetchFn: mockFetch });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(mockFetch).toHaveBeenCalledWith('/api/imports/form-materialize', expect.any(Object));

    // Verify enriched payload sent to server
    const payload = capturedPayload as Record<string, unknown>;
    expect(payload.snapshotAltText).toBe('Lab testing setup');
    expect(payload.snapshot1ContentKind).toBe('ordinary');
    expect(payload.snapshot1FullText).toBe('');
    expect(payload.snapshot2AltText).toBe('Block diagram');
    expect(payload.snapshot2ContentKind).toBe('text_bearing');
    expect(payload.snapshot2FullText).toBe('Microcontroller to radio link');
    expect(payload.snapshot3AltText).toBe('');
    expect(payload.snapshot3ContentKind).toBe('');

    // Verify synthetic package files
    const pkg = result.package;
    expect(pkg.selectedRootName).toBe('rover-mission-2026');
    expect(pkg.files).toHaveLength(5);
    expect(pkg.files.map((f) => f.name)).toEqual([
      'project-details.xlsx',
      'poster.png',
      'poster.pdf',
      'snapshot-1.png',
      'snapshot-2.jpg',
    ]);
  });

  it('handles server validation errors safely', async () => {
    const metadata = createInitialFormIntakeMetadata();
    const media = createInitialFormIntakeMediaState();

    const mockFetch = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        json: async () => ({ code: 'VALIDATION_ERROR', error: 'Invalid form metadata.' }),
      } as Response;
    });

    const result = await materializeFormIntakePackage(metadata, media, { fetchFn: mockFetch });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('Invalid form metadata.');
  });

  it('handles network connection failures gracefully', async () => {
    const metadata = createInitialFormIntakeMetadata();
    const media = createInitialFormIntakeMediaState();

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network disconnected'));

    const result = await materializeFormIntakePackage(metadata, media, { fetchFn: mockFetch });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('Network error');
  });
});
