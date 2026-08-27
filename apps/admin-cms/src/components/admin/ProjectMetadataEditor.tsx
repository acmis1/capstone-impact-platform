'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { MultiSelect } from '../ui/multi-select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  MetadataOption,
  ProjectMetadataActionResult,
  ProjectMetadataView,
  projectMetadataInputSchema,
} from '../../projects/projectMetadata';
import { editorCanSubmit, isMetadataDirty } from './projectMetadataEditorState';
import { useProjectMetadataNavigation } from './ProjectMetadataNavigation';
import { invokeProjectMetadataSave } from './projectMetadataEditorController';
import { PROJECT_DETAIL_SURFACE_CLASSES } from './projectDetailSurfaceStyles';
import { PencilLine } from 'lucide-react';

/** Token-aligned select styling so the editor keeps the shared 40px control rhythm. */
const SELECT_CLASSES =
  'flex min-h-[40px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';

interface Props {
  initialMetadata: ProjectMetadataView;
  programs: MetadataOption[];
  disciplines: MetadataOption[];
  industryCategories: MetadataOption[];
  canEdit: boolean;
  projectStatus: string;
  saveAction: (input: unknown) => Promise<ProjectMetadataActionResult>;
  headingLevel?: 'h2' | 'h3' | 'h4';
}

export function ProjectMetadataEditor({
  initialMetadata,
  programs,
  disciplines,
  industryCategories,
  canEdit,
  projectStatus,
  saveAction,
  headingLevel: Heading = 'h2',
}: Props) {
  const router = useRouter();
  const { setDirty, registerTitleSuggestionHandler } = useProjectMetadataNavigation();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [initial, setInitial] = useState(initialMetadata);
  const [draft, setDraft] = useState(initialMetadata);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<{ kind: 'affirm' | 'blocker'; message: string } | null>(null);
  const [pendingSuggestion, setPendingSuggestion] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const inFlight = useRef(false);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const dirty = isMetadataDirty(initial, draft);

  const protectedNotice =
    projectStatus === 'approved'
      ? 'This project is approved. Request changes before editing project information.'
      : projectStatus === 'published'
      ? 'Published project information is locked until a controlled revision workflow is available.'
      : null;

  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);

  useEffect(() => {
    if (notice?.kind === 'blocker' && Object.keys(fieldErrors).length > 0) summaryRef.current?.focus();
  }, [notice, fieldErrors]);

  const draftRef = useRef(draft);
  const initialRef = useRef(initial);

  useEffect(() => {
    draftRef.current = draft;
    initialRef.current = initial;
  }, [draft, initial]);

  const focusAndScrollTitle = () => {
    requestAnimationFrame(() => {
      const input = document.getElementById('metadata-title');
      input?.focus();
      const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      input?.scrollIntoView?.({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'center',
      });
    });
  };

  const applyTitleDirectly = useCallback((titleToApply: string) => {
    setMode('edit');
    setDraft((prev) => ({ ...prev, title: titleToApply }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.title;
      return next;
    });
    setNotice({
      kind: 'affirm',
      message: 'Suggestion applied to the draft. Review it and select Save changes to persist the change.',
    });
    focusAndScrollTitle();
  }, []);

  useEffect(() => {
    if (!canEdit || protectedNotice) {
      registerTitleSuggestionHandler(null);
      return;
    }
    const handler = (suggestedTitle: string): boolean => {
      const currentDraft = draftRef.current;
      const currentInitial = initialRef.current;
      if (currentDraft.title !== currentInitial.title && currentDraft.title !== suggestedTitle) {
        setPendingSuggestion(suggestedTitle);
        return true;
      }
      applyTitleDirectly(suggestedTitle);
      return true;
    };
    registerTitleSuggestionHandler(handler);
    return () => registerTitleSuggestionHandler(null);
  }, [canEdit, protectedNotice, registerTitleSuggestionHandler, applyTitleDirectly]);

  const cancel = () => {
    if (dirty) {
      setShowCancelConfirm(true);
      return;
    }
    setDraft(initial);
    setFieldErrors({});
    setNotice(null);
    setMode('view');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || !editorCanSubmit(pending, dirty)) return;
    const local = projectMetadataInputSchema.safeParse(draft);
    if (!local.success) {
      setFieldErrors(local.error.flatten().fieldErrors);
      setNotice({ kind: 'blocker', message: 'Review the highlighted fields and try again.' });
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFieldErrors({});
    setNotice(null);
    try {
      const result = await invokeProjectMetadataSave(saveAction, draft);
      if (!result.ok) {
        setFieldErrors(result.fieldErrors || {});
        setNotice({ kind: 'blocker', message: result.message });
        return;
      }
      setInitial(result.metadata);
      setDraft(result.metadata);
      setNotice({ kind: 'affirm', message: 'Project information saved.' });
      setMode('view');
      router.refresh();
    } catch {
      setNotice({ kind: 'blocker', message: 'We could not save your changes. Please try again.' });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const message = (name: string) => fieldErrors[name]?.[0];

  if (mode === 'view') {
    return (
      <section aria-labelledby="metadata-editor-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <Heading id="metadata-editor-title" className="text-base font-semibold tracking-tight text-foreground">
              Project information
            </Heading>
            <p className="mt-1 max-w-[72ch] text-sm leading-relaxed text-muted-foreground">
              Title, summary, background, solution, poster full text, accessibility text, year, program, disciplines and industry categories.
            </p>
          </div>
          {canEdit && !protectedNotice ? (
            <Button
              type="button"
              className="shrink-0"
              onClick={() => {
                setNotice(null);
                setMode('edit');
              }}
            >
              <PencilLine aria-hidden="true" />
              Edit project information
            </Button>
          ) : (
            <p role="status" className="max-w-[40ch] shrink-0 text-sm text-muted-foreground sm:text-right">
              {protectedNotice || 'Read-only: your role cannot edit project information.'}
            </p>
          )}
        </div>
        {notice && (
          <p role="status" className={`mt-4 p-3 text-sm font-medium ${PROJECT_DETAIL_SURFACE_CLASSES[notice.kind]}`}>
            {notice.message}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="metadata-editor-title"
      className="-m-4 rounded-xl border-2 border-primary/40 bg-surface-subtle p-4 sm:-m-6 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading id="metadata-editor-title" className="text-base font-semibold tracking-tight text-foreground">
          Editing project information
        </Heading>
        {dirty && (
          <p role="status" className={`px-2.5 py-1 text-sm font-medium ${PROJECT_DETAIL_SURFACE_CLASSES.caution}`}>
            Unsaved changes
          </p>
        )}
      </div>

      {notice?.kind === 'blocker' ? (
        <p
          id="metadata-form-error"
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className={`mt-3 p-3 text-sm font-medium ${PROJECT_DETAIL_SURFACE_CLASSES.blocker}`}
        >
          {notice.message}
        </p>
      ) : (
        notice && (
          <p role="status" className={`mt-3 p-3 text-sm font-medium ${PROJECT_DETAIL_SURFACE_CLASSES.affirm}`}>
            {notice.message}
          </p>
        )
      )}

      <form
        className="mt-5 max-w-[70ch] space-y-5"
        onSubmit={submit}
        noValidate
        aria-describedby={notice?.kind === 'blocker' ? 'metadata-form-error' : undefined}
      >
        <Field id="metadata-title" label="Project title" error={message('title')}>
          <Input
            id="metadata-title"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            aria-invalid={Boolean(message('title'))}
            aria-describedby={message('title') ? 'metadata-title-error' : undefined}
          />
        </Field>

        <Field id="metadata-summary" label="Short summary" error={message('summary')}>
          <Textarea
            id="metadata-summary"
            value={draft.summary}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            aria-invalid={Boolean(message('summary'))}
            aria-describedby={message('summary') ? 'metadata-summary-error' : undefined}
          />
        </Field>

        <Field id="metadata-background" label="Problem background" error={message('background')}>
          <Textarea
            id="metadata-background"
            value={draft.background}
            onChange={(e) => setDraft({ ...draft, background: e.target.value })}
            aria-invalid={Boolean(message('background'))}
            aria-describedby={message('background') ? 'metadata-background-error' : undefined}
          />
        </Field>

        <Field id="metadata-solution" label="Developed solution" error={message('solution')}>
          <Textarea
            id="metadata-solution"
            value={draft.solution}
            onChange={(e) => setDraft({ ...draft, solution: e.target.value })}
            aria-invalid={Boolean(message('solution'))}
            aria-describedby={message('solution') ? 'metadata-solution-error' : undefined}
          />
        </Field>

        <Field
          id="metadata-poster-text"
          label="Poster full text"
          error={message('posterText')}
          instruction="Full text version of the meaningful content on the poster, so the published page is searchable and readable without the image. Required before this project can be submitted for review, approved, or published."
        >
          <Textarea
            id="metadata-poster-text"
            rows={8}
            value={draft.posterText}
            onChange={(e) => setDraft({ ...draft, posterText: e.target.value })}
            aria-invalid={Boolean(message('posterText'))}
            aria-describedby={
              message('posterText')
                ? 'metadata-poster-text-error metadata-poster-text-instruction'
                : 'metadata-poster-text-instruction'
            }
          />
        </Field>

        <Field
          id="metadata-accessibility-text"
          label="Accessibility text"
          error={message('accessibilityText')}
          instruction="Short description of the poster image for people using a screen reader. Describe what the poster shows, not its full contents. Required before this project can be submitted for review, approved, or published."
        >
          <Textarea
            id="metadata-accessibility-text"
            rows={4}
            value={draft.accessibilityText}
            onChange={(e) => setDraft({ ...draft, accessibilityText: e.target.value })}
            aria-invalid={Boolean(message('accessibilityText'))}
            aria-describedby={
              message('accessibilityText')
                ? 'metadata-accessibility-text-error metadata-accessibility-text-instruction'
                : 'metadata-accessibility-text-instruction'
            }
          />
        </Field>

        <Field id="metadata-year" label="Project year" error={message('year')}>
          <Input
            id="metadata-year"
            inputMode="numeric"
            value={draft.year}
            onChange={(e) => setDraft({ ...draft, year: e.target.value })}
            aria-invalid={Boolean(message('year'))}
            aria-describedby={message('year') ? 'metadata-year-error' : undefined}
          />
        </Field>

        <Field id="metadata-program" label="Program" error={message('programId')}>
          <select
            id="metadata-program"
            className={SELECT_CLASSES}
            value={draft.programId}
            onChange={(e) => setDraft({ ...draft, programId: e.target.value })}
            aria-invalid={Boolean(message('programId'))}
            aria-describedby={message('programId') ? 'metadata-program-error' : undefined}
          >
            {programs.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>

        <Field id="metadata-disciplines" label="Disciplines" error={message('disciplineIds')}>
          <MultiSelect
            id="metadata-disciplines"
            label="Disciplines"
            options={disciplines}
            value={draft.disciplineIds}
            onChange={(ids) => setDraft({ ...draft, disciplineIds: ids })}
            aria-invalid={Boolean(message('disciplineIds'))}
            aria-describedby={message('disciplineIds') ? 'metadata-disciplines-error' : undefined}
          />
        </Field>

        <Field id="metadata-industries" label="Industry categories" error={message('industryCategoryIds')}>
          <MultiSelect
            id="metadata-industries"
            label="Industry categories"
            options={industryCategories}
            value={draft.industryCategoryIds}
            onChange={(ids) => setDraft({ ...draft, industryCategoryIds: ids })}
            aria-invalid={Boolean(message('industryCategoryIds'))}
            aria-describedby={message('industryCategoryIds') ? 'metadata-industries-error' : undefined}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <Button type="submit" size="lg" disabled={!editorCanSubmit(pending, dirty)} aria-busy={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
          <Button type="button" variant="ghost" onClick={cancel} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>

      {/* Suggestion Replacement Confirmation Dialog */}
      <AlertDialog
        open={pendingSuggestion !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSuggestion(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace unsaved title?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in Project title. Replacing it with the suggestion will overwrite your current draft.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingSuggestion(null)}>
              Keep current title
            </AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              onClick={() => {
                if (pendingSuggestion) {
                  const titleToApply = pendingSuggestion;
                  setPendingSuggestion(null);
                  applyTitleDirectly(titleToApply);
                }
              }}
            >
              Replace title
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discard Changes Confirmation Dialog */}
      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in project information. Discarding changes will revert all fields to their last saved values.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowCancelConfirm(false)}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setShowCancelConfirm(false);
                setDraft(initial);
                setFieldErrors({});
                setNotice(null);
                setMode('view');
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Field({
  id,
  label,
  error,
  instruction,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  instruction?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {instruction && (
        <p id={`${id}-instruction`} className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
          {instruction}
        </p>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive-strong">
          {error}
        </p>
      )}
    </div>
  );
}
