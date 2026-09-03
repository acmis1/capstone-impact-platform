'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CorrectionDecision, CorrectionReviewView } from '../../previews/participantCorrectionReview';
import { Button } from '../ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';

const labels = { begin: 'Begin review of this revision', accept: 'Accept this participant revision', return: 'Return this revision' };
const displayName = (name: string) => name.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());

export function ParticipantCorrectionReview({ publicId, view, canDecide }: { publicId: string; view: CorrectionReviewView; canDecide: boolean }) {
  const router = useRouter();
  const [action, setAction] = useState<CorrectionDecision['action'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [completedRevision, setCompletedRevision] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const running = useRef(false);
  const candidate = view.candidate;
  const completed = completedRevision === `${candidate?.id}:${candidate?.state}`;
  if (!view.available) return <p role="status">Correction package evidence is unavailable. Review actions are disabled until it can be verified.</p>;
  if (!candidate) return <p role="status">Waiting for a complete corrected package from the project team. The active participant preview offers the upload form after they request a correction.</p>;
  const open = (choice: CorrectionDecision['action']) => { trigger.current = document.activeElement as HTMLElement; setAction(choice); };
  const decide = async () => {
    if (!action || running.current || !canDecide) return;
    running.current = true; setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/participant-preview/correction-resolution`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, submissionId: candidate.id, packageHash: candidate.hash, expectedVersion: candidate.expectedVersion }),
      });
      const result = await response.json();
      if (!response.ok || result.success !== true) throw new Error('The decision could not be completed. Reload to check the current revision and try again.');
      setCompletedRevision(`${candidate.id}:${candidate.state}`); router.refresh();
    } catch { setError('The decision could not be completed. Reload to check the current revision and try again.'); }
    finally { running.current = false; setBusy(false); setAction(null); }
  };
  return <section aria-labelledby="correction-package-review" className="mt-5 space-y-4 border-t border-border pt-5">
    <h3 id="correction-package-review" className="font-semibold">Participant correction package</h3>
    <p className="text-sm">Complete replacement submission received {new Date(candidate.submittedAt).toLocaleString()}. Status: <strong>{candidate.state}</strong>.</p>
    <p className="text-sm">Package validation passed. Submitted file bytes have been verified against this revision’s hashes.</p>
    <p className="text-sm">Review the participant’s correction comment above, compare every field and file below, then decide on this exact revision. Staff cannot edit its contents.</p>
    <details><summary className="cursor-pointer text-sm">Revision identity</summary><p className="break-all text-xs">SHA-256: {candidate.hash}</p></details>
    {candidate.warnings.length > 0 && <div><h4 className="font-medium">Package warnings</h4><ul className="list-disc pl-5 text-sm">{candidate.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
    <details open><summary className="cursor-pointer font-medium">Project information comparison</summary>
      <div className="mt-3 space-y-3">{candidate.fields.map((field) => <div key={field.name} className="rounded border border-border p-3">
        <h4 className="font-medium">{displayName(field.name)}{field.changed ? ' — changed' : ' — unchanged'}</h4>
        <div className="mt-2 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div><p className="font-medium">Current draft</p><p className="whitespace-pre-wrap break-words">{field.current || 'Not provided'}</p></div>
          <div><p className="font-medium">Participant submission</p><p className="whitespace-pre-wrap break-words">{field.proposed || 'Not provided'}</p></div>
        </div>
      </div>)}</div>
    </details>
    <div><h4 className="font-medium">Current media</h4><ul className="mt-2 space-y-2 text-sm">{candidate.currentMedia.map((file) => {
      const replacement = candidate.files.find((f) => f.role === file.role && f.position === file.position);
      return <li key={`${file.role}-${file.position}`} className="break-words">
        {file.role.replaceAll('_', ' ')} {file.position}: {file.fileName}. <strong>{!replacement ? 'Omitted from complete replacement' : replacement.hash === file.hash ? 'Same file bytes' : 'File bytes changed'}</strong>
        <p>Current description: {file.altText || 'Uses project accessibility text'}</p>
      </li>;
    })}</ul></div>
    <div><h4 className="font-medium">Submitted files</h4><ul className="mt-2 space-y-3 text-sm">{candidate.files.map((file) => <li key={`${file.role}-${file.position}`} className="break-words">
      <a href={file.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="underline">Review {file.role.replaceAll('_', ' ')} {file.position}: {file.fileName}</a>
      <p>{file.bytes.toLocaleString()} bytes. {file.altText ? `Description: ${file.altText}` : file.role === 'poster_image' ? 'Uses the submitted project accessibility text.' : ''}</p>
      <details><summary className="cursor-pointer">File identity</summary><p className="break-all text-xs">SHA-256: {file.hash}</p></details>
    </li>)}</ul></div>
    {candidate.state === 'accepted' && <p role="status">Participant revision accepted. Run the normal technical and review checks, re-approve, issue the corrected participant preview, and obtain a new confirmation before publication readiness.</p>}
    {candidate.state === 'returned' && <p role="status">Revision returned. The old preview remains revoked. Review the retained draft, re-approve it and issue a new preview so the project team can begin another correction cycle.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {completed && <p role="status">Decision recorded. Refreshing the current evidence…</p>}
    {canDecide && ['submitted', 'frozen'].includes(candidate.state) && <div className="flex flex-wrap gap-2">
      <Button disabled={busy || completed} onClick={() => open(candidate.state === 'submitted' ? 'begin' : 'accept')}>{labels[candidate.state === 'submitted' ? 'begin' : 'accept']}</Button>
      {candidate.state === 'frozen' && <Button variant="outline" disabled={busy || completed} onClick={() => open('return')}>{labels.return}</Button>}
    </div>}
    <AlertDialog open={action !== null} onOpenChange={(value) => { if (!value && !busy) setAction(null); }}>
      <AlertDialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
        <AlertDialogHeader><AlertDialogTitle>{action ? labels[action] : 'Review revision'}</AlertDialogTitle>
          <AlertDialogDescription>{action === 'begin'
            ? 'Freeze this exact participant submission, revoke the original preview and move the project to changes requested. The project team cannot change the frozen package. Review every comparison before accepting it.'
            : action === 'accept'
              ? 'Apply this complete participant-authored package to the draft. Omitted project media and taxonomy mappings will be retired with complete recovery records. All old files remain in Storage. This does not approve or publish the project.'
              : candidate.state === 'frozen'
                ? 'Keep the current draft. The original preview stays revoked. Review and re-approve the retained draft, then issue a new preview so the project team can begin another correction cycle.'
                : 'Keep the current draft. The project team can submit a replacement through the active preview while the submission limit permits.'}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void decide(); }}>{busy ? 'Recording…' : action ? labels[action] : 'Continue'}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
