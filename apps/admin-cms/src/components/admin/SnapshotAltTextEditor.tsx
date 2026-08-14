'use client';

import React, { useId, useState } from 'react';

import { ACCESSIBLE_CONTENT_LIMITS } from '../../domain/accessibleContent';
import type { SnapshotAltTextActionResult } from '../../projects/snapshotAltText';

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
    <div style={{ marginTop: '0.75rem' }}>
      <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', color: '#9CA3AF', fontWeight: 'normal' }}>
        Snapshot image alt text
      </h4>

      {!isEditing && (
        <>
          {savedAltText === '' ? (
            <p style={{ margin: '0 0 0.5rem', color: '#F59E0B' }} role="status">
              Snapshot alt text missing. This project cannot be submitted for review, approved, previewed
              by participants, or published until it is provided.
            </p>
          ) : (
            <p style={{ margin: '0 0 0.5rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{savedAltText}</p>
          )}

          {canEdit && !isLockedByStatus && (
            <button type="button" onClick={() => setIsEditing(true)}>
              {savedAltText === '' ? 'Add alt text' : 'Edit alt text'}
            </button>
          )}
          {canEdit && isLockedByStatus && (
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#9CA3AF' }}>{lockedReason}</p>
          )}
        </>
      )}

      {isEditing && (
        <div>
          <label htmlFor={fieldId} style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
            Describe the meaningful content of the snapshot image
          </label>
          <textarea
            id={fieldId}
            value={draft}
            rows={4}
            maxLength={undefined}
            disabled={isSaving}
            aria-describedby={`${fieldId}-help`}
            aria-invalid={errorMessage ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.85rem' }}
          />
          <p id={`${fieldId}-help`} style={{ margin: '0.25rem 0', fontSize: '0.75rem', color: '#9CA3AF' }}>
            {`Up to ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText.toLocaleString('en-US')} characters. Currently ${draft.trim().length.toLocaleString('en-US')}.`}
          </p>
          <button type="button" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save alt text'}
          </button>
          <button type="button" onClick={handleCancel} disabled={isSaving}>
            Cancel
          </button>
        </div>
      )}

      {errorMessage && (
        <p role="alert" style={{ margin: '0.5rem 0 0', color: '#F87171' }}>{errorMessage}</p>
      )}
      {statusMessage && !errorMessage && (
        <p role="status" style={{ margin: '0.5rem 0 0', color: '#10B981' }}>{statusMessage}</p>
      )}
    </div>
  );
}
