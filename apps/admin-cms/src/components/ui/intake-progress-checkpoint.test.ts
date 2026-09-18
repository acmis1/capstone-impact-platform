import { describe, expect, it } from 'vitest';
import { createInitialFormIntakeMetadata, createInitialFormIntakeMediaState } from '../../import/formIntakeContract';
import { createManualIntakeCheckpoint, createPackageIntakeCheckpoint, parseIntakeProgressCheckpoint, MAX_INTAKE_CHECKPOINT_BYTES } from './intake-progress-checkpoint';

describe('bounded resumable intake checkpoints', () => {
  it('round-trips the supported poster-text ceiling without restoring identity or files', () => {
    const metadata = { ...createInitialFormIntakeMetadata(), posterText: 'x'.repeat(20_000), title: 'Synthetic saved draft', participantContactEmail: 'private@example.invalid', teamMembers: 'Private contact', academicSupervisor: 'Private supervisor', industryPartner: 'Private partner' };
    const checkpoint = createManualIntakeCheckpoint(metadata, createInitialFormIntakeMediaState(), 1);
    const loaded = parseIntakeProgressCheckpoint(JSON.stringify(checkpoint));
    expect(loaded).toEqual(checkpoint);
    expect(JSON.stringify(loaded)).not.toContain('private@example.invalid');
    expect(JSON.stringify(loaded)).not.toContain('Private contact');
    expect(JSON.stringify(loaded)).not.toContain('Private supervisor');
    expect(JSON.stringify(loaded)).not.toContain('Private partner');
    expect(loaded.kind === 'manual-form' && loaded.metadata.posterText?.length).toBe(20_000);
  });
  it('round-trips a 120-project, 13-file-per-project manifest', () => {
    const files = Array.from({ length: 1560 }, (_, index) => `projects/synthetic-group-${Math.floor(index / 13)}/bounded-file-${index}.png`);
    const checkpoint = createPackageIntakeCheckpoint({ selectedRootName: 'projects', selectedFileNames: files, selectedPackagePaths: Array.from({ length: 120 }, (_, index) => `synthetic-group-${index}`) });
    expect(parseIntakeProgressCheckpoint(JSON.stringify(checkpoint))).toEqual(checkpoint);
    expect(new TextEncoder().encode(JSON.stringify(checkpoint)).length).toBeLessThan(MAX_INTAKE_CHECKPOINT_BYTES);
  });
  it('rejects unknown fields, versions, overlong content and duplicate gallery positions', () => {
    const checkpoint = createManualIntakeCheckpoint(createInitialFormIntakeMetadata(), createInitialFormIntakeMediaState(), 1);
    expect(() => parseIntakeProgressCheckpoint({ ...checkpoint, version: 2 })).toThrow();
    expect(() => parseIntakeProgressCheckpoint({ ...checkpoint, capabilityToken: 'forbidden' })).toThrow();
    expect(() => parseIntakeProgressCheckpoint('x'.repeat(MAX_INTAKE_CHECKPOINT_BYTES + 1))).toThrow(/large/);
    expect(() => createManualIntakeCheckpoint({ ...createInitialFormIntakeMetadata(), posterText: 'x'.repeat(20_001) }, createInitialFormIntakeMediaState(), 1)).toThrow();
    if (checkpoint.kind !== 'manual-form') throw new Error('Wrong fixture kind');
    expect(() => parseIntakeProgressCheckpoint({ ...checkpoint, media: { ...checkpoint.media, galleryImages: [checkpoint.media.galleryImages[0], checkpoint.media.galleryImages[0]] } })).toThrow();
  });
});
