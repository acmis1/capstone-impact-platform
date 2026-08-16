'use client';

import React, { useId, useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Alert } from '../ui/alert';
import { ACCESSIBLE_CONTENT_LIMITS } from '../../domain/accessibleContent';
import type { SnapshotAltTextActionResult } from '../../projects/snapshotAltText';
import { CheckCircle2, AlertTriangle, Edit3, Plus } from 'lucide-react';

interface SnapshotAltTextEditorProps {
  publicId: string;
  /** The authoritative saved value, or empty when none is stored yet. */
  initialAltText: string;
  /** The project version this view was rendered from; shared with the metadata editor. */
  initialExpectedUpdatedAt: string;
  canEdit: boolean;
  projectStatus: string;
  saveAction: (rawInput: unknown) => Promise<SnapshotAltTextActionResult>;
}

/**
 * Staff editing surface for the authoritative text alternative of the project's snapshot image.
 *
 * Deliberately part of the existing project media area rather than a separate dashboard, and
 * deliberately separate from the poster: the poster's text alternative remains the project-level
 * Accessibility text field in the metadata editor, and is never duplicated here.
 *
 * The editor states plainly when nothing is stored. It never pre-fills a suggestion from the
 * filename, the project title, or anything else — an alt text nobody wrote is not accessibility.
 */
export function SnapshotAltTextEditor({
  publicId,
  initialAltText,
  initialExpectedUpdatedAt,
  canEdit,
  projectStatus,
  saveAction,
}: SnapshotAltTextEditorProps) {
  const fieldId = useId();
  const [savedAltText, setSavedAltText] = useState(initialAltText);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(initialExpectedUpdatedAt);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(initialAltText);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Approved and published projects are edited through their own controlled workflows; showing an
  // enabled control that the server would reject would be a fake control.
  const isLockedByStatus = projectStatus === 'approved' || projectStatus === 'published';
  const lockedReason =
    projectStatus === 'approved'
      ? 'This project is approved. Request changes before editing snapshot image alt text.'
      : 'Published project accessibility text is locked until a controlled revision workflow is available.';

  async function handleSave() {
    setIsSaving(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const result = await saveAction({ publicId, snapshotAltText: draft, expectedUpdatedAt });
      if (result.ok) {
        setSavedAltText(result.snapshot.snapshotAltText);
        setDraft(result.snapshot.snapshotAltText);
        setExpectedUpdatedAt(result.snapshot.expectedUpdatedAt);
        setIsEditing(false);
        setStatusMessage('Snapshot image alt text saved.');
      } else {
        setErrorMessage(result.message);
      }
    } catch {
      setErrorMessage('We could not save your changes. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }

  function handleCancel() {
    setDraft(savedAltText);
    setIsEditing(false);
    setErrorMessage(null);
    setStatusMessage(null);
  }

  return (
    <div className="flex flex-col gap-2.5 text-xs sm:text-sm">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Snapshot image alt text
        </h4>
        {!isEditing && canEdit && !isLockedByStatus && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsEditing(true)}
            className="h-7 text-xs font-medium"
          >
            {savedAltText === '' ? (
              <>
                <Plus className="h-3 w-3 mr-1" aria-hidden="true" />
                Add alt text
              </>
            ) : (
              <>
                <Edit3 className="h-3 w-3 mr-1" aria-hidden="true" />
                Edit alt text
              </>
            )}
          </Button>
        )}
      </div>

      {!isEditing && (
        <div className="flex flex-col gap-2">
          {savedAltText === '' ? (
            <div className="p-3 rounded-md bg-warning/10 border border-warning/30 text-warning text-xs flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                Snapshot alt text missing. This project cannot be submitted for review, approved, previewed by participants, or published until it is provided.
              </span>
            </div>
          ) : (
            <p className="text-foreground text-xs leading-relaxed whitespace-pre-wrap break-words bg-muted/30 p-3 rounded-md border border-border">
              {savedAltText}
            </p>
          )}

          {canEdit && isLockedByStatus && (
            <p className="text-xs text-muted-foreground">{lockedReason}</p>
          )}
        </div>
      )}

      {isEditing && (
        <div className="flex flex-col gap-2.5 p-3.5 rounded-lg bg-muted/40 border border-border">
          <Label htmlFor={fieldId} className="text-xs font-medium text-foreground">
            Describe the meaningful content of the snapshot image
          </Label>
          <Textarea
            id={fieldId}
            value={draft}
            rows={4}
            disabled={isSaving}
            aria-describedby={`${fieldId}-help`}
            aria-invalid={errorMessage ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            className="text-xs font-normal"
          />
          <p id={`${fieldId}-help`} className="text-[11px] text-muted-foreground">
            {`Up to ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText.toLocaleString('en-US')} characters. Currently ${draft.trim().length.toLocaleString('en-US')}.`}
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
              className="font-semibold"
            >
              {isSaving ? 'Saving…' : 'Save alt text'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={isSaving}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {errorMessage && (
        <Alert
          variant="destructive"
          title="Save Failed"
          description={errorMessage}
        />
      )}
      {statusMessage && !errorMessage && (
        <div className="p-2.5 rounded-md bg-success/10 border border-success/30 text-success text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{statusMessage}</span>
        </div>
      )}
    </div>
  );
}
