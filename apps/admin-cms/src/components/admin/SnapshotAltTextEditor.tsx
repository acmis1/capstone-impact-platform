import type { SnapshotAltTextActionResult } from '../../projects/snapshotAltText';

interface SnapshotAltTextEditorProps {
  publicId: string;
  mediaAssetId: string;
  /** The authoritative saved value, or empty when none is stored yet. */
  initialAltText: string;
  /** The current shared project version for this snapshot gallery editing surface. */
  expectedUpdatedAt: string;
  canEdit: boolean;
  projectStatus: string;
  saveAction: (rawInput: unknown) => Promise<SnapshotAltTextActionResult>;
  onSavedExpectedUpdatedAt?: (expectedUpdatedAt: string) => void;
}

export function SnapshotAltTextEditor({ initialAltText }: SnapshotAltTextEditorProps) {
  return (
    <section className="space-y-2 text-sm" aria-label="Snapshot image alt text">
      <h4 className="font-semibold">Snapshot image alt text</h4>
      <p className="whitespace-pre-wrap break-words">{initialAltText || 'No description supplied. A corrected project-team package is required.'}</p>
      <p className="text-muted-foreground">This description is owned by the project team. Flag any accessibility issue in a change request.</p>
    </section>
  );
}
