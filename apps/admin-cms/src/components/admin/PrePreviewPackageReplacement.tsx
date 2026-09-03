'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../ui/button';
import { ParticipantCorrectionReview } from './ParticipantCorrectionReview';
import type { CorrectionReviewView } from '../../previews/participantCorrectionReview';

const roles = [
  { name: 'workbook', label: 'Project details workbook', accept: '.xlsx', required: true },
  { name: 'poster', label: 'Poster image', accept: '.png,.jpg,.jpeg,.webp', required: true },
  { name: 'pdf', label: 'Poster PDF', accept: '.pdf', required: true },
  ...Array.from({ length: 10 }, (_, i) => ({ name: `snapshot${i + 1}`, label: `Supporting image ${i + 1}`, accept: '.png,.jpg,.jpeg,.webp', required: false })),
];

export function PrePreviewPackageReplacement({ publicId, view, canSubmit }: { publicId: string; view: CorrectionReviewView; canSubmit: boolean }) {
  const router = useRouter();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running.current || !canSubmit) return;
    const form = event.currentTarget;
    const body = new FormData(form);
    // Empty optional inputs are omitted; the bounded parser accepts only actual file parts.
    for (const [key, value] of [...body.entries()]) if (value instanceof File && value.size === 0) body.delete(key);
    running.current = true; setBusy(true); setError(null); setSubmitted(false);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/package-replacement`, { method: 'POST', body });
      const result = await response.json();
      if (!response.ok || result.success !== true) { setError(typeof result.error === 'string' ? result.error : 'The package could not be submitted. Retry the same files.'); return; }
      form.reset(); setSubmitted(true); router.refresh();
    } catch { setError('The upload could not be completed. Retry the same files; the current project remains unchanged.'); }
    finally { running.current = false; setBusy(false); }
  };
  return <section id="project-team-package" aria-labelledby="project-team-package-heading" className="space-y-4 rounded-xl border border-border bg-card p-5">
    <h2 id="project-team-package-heading" className="text-lg font-semibold">Replace project-team package</h2>
    <p>Ask the project team to correct their source files and supply a complete package. Upload those files here, compare the proposed revision, then explicitly accept it. Project information cannot be edited here.</p>
    <p className="text-sm text-muted-foreground">Available before the first participant preview. Applying a package preserves the review state and does not approve or publish the project.</p>
    {canSubmit ? <form onSubmit={submit} className="space-y-4" aria-describedby="replacement-package-limits">
      <p id="replacement-package-limits" className="text-sm">Workbook and each image: up to 5 MB. PDF: up to 20 MB. Complete package: up to 32 MB. Include the workbook, both poster files and every supporting image to retain. The workbook must describe each supporting image at its numbered position.</p>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="sr-only">Complete project-team replacement package</legend>
        {roles.map((role) => <div key={role.name}>
          <label className="mb-1 block text-sm font-medium" htmlFor={`replacement-${role.name}`}>{role.label}{role.required ? ' (required)' : ' (optional)'}</label>
          <input className="block w-full min-w-0 rounded border border-input p-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" type="file" id={`replacement-${role.name}`} name={role.name} accept={role.accept} required={role.required} />
        </div>)}
        <Button type="submit" disabled={busy}>{busy ? 'Validating and uploading…' : 'Upload complete replacement package'}</Button>
      </fieldset>
      {busy && <p role="status">Validating and uploading the complete package. Keep this page open.</p>}
    </form> : <p role="status">Uploads are paused while a package is frozen or the three-package allowance has been reached. Review the submitted package below.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {submitted && <p role="status">Package submitted for comparison. The current project is unchanged until you accept the exact revision.</p>}
    <ParticipantCorrectionReview publicId={publicId} view={view} canDecide prePreview />
  </section>;
}
