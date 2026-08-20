'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { MetadataOption, ProjectMetadataActionResult, ProjectMetadataView, projectMetadataInputSchema } from '../../projects/projectMetadata';
import { editorCanSubmit, isMetadataDirty } from './projectMetadataEditorState';
import { useProjectMetadataNavigation } from './ProjectMetadataNavigation';
import { invokeProjectMetadataSave } from './projectMetadataEditorController';
import { PROJECT_DETAIL_SURFACE_CLASSES } from './projectDetailSurfaceStyles';
import { PencilLine } from 'lucide-react';

/** Token-aligned select styling so the editor keeps the shared 40px control rhythm. */
const SELECT_CLASSES = 'flex min-h-[40px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';
const MULTI_SELECT_CLASSES = 'flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';

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

const selectValues = (event: React.ChangeEvent<HTMLSelectElement>) => Array.from(event.currentTarget.selectedOptions, (option) => option.value);

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
  const { setDirty, confirmDiscard, registerTitleSuggestionHandler } = useProjectMetadataNavigation();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [initial, setInitial] = useState(initialMetadata);
  const [draft, setDraft] = useState(initialMetadata);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const dirty = isMetadataDirty(initial, draft);

  const protectedNotice = projectStatus === 'approved' ? 'This project is approved. Request changes before editing metadata.' : projectStatus === 'published' ? 'Published project metadata is locked until a controlled revision workflow is available.' : null;

  useEffect(() => { setDirty(dirty); return () => setDirty(false); }, [dirty, setDirty]);
  useEffect(() => { if (notice && Object.keys(fieldErrors).length > 0) summaryRef.current?.focus(); }, [notice, fieldErrors]);

  const draftRef = useRef(draft);
  const initialRef = useRef(initial);

  useEffect(() => {
    draftRef.current = draft;
    initialRef.current = initial;
  }, [draft, initial]);

  useEffect(() => {
    if (!canEdit || protectedNotice) {
      registerTitleSuggestionHandler(null);
      return;
    }
    const handler = (suggestedTitle: string): boolean => {
      const currentDraft = draftRef.current;
      const currentInitial = initialRef.current;
      if (currentDraft.title !== currentInitial.title && currentDraft.title !== suggestedTitle) {
        const proceed = window.confirm('You have unsaved changes in Project title. Replace it with the suggestion?');
        if (!proceed) return false;
      }
      setMode('edit');
      setDraft((prev) => ({ ...prev, title: suggestedTitle }));
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next.title;
        return next;
      });
      setNotice('Suggestion applied to the draft. Review it and select Save metadata to persist the change.');
      requestAnimationFrame(() => {
        const input = document.getElementById('metadata-title');
        input?.focus();
        input?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      });
      return true;
    };
    registerTitleSuggestionHandler(handler);
    return () => registerTitleSuggestionHandler(null);
  }, [canEdit, protectedNotice, registerTitleSuggestionHandler]);

  const cancel = () => {
    if (!confirmDiscard()) return;
    setDraft(initial); setFieldErrors({}); setNotice(null); setMode('view');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || !editorCanSubmit(pending, dirty)) return;
    const local = projectMetadataInputSchema.safeParse(draft);
    if (!local.success) { setFieldErrors(local.error.flatten().fieldErrors); setNotice('Review the highlighted fields and try again.'); return; }
    inFlight.current = true;
    setPending(true); setFieldErrors({}); setNotice(null);
    try {
      const result = await invokeProjectMetadataSave(saveAction, draft);
      if (!result.ok) { setFieldErrors(result.fieldErrors || {}); setNotice(result.message); return; }
      setInitial(result.metadata); setDraft(result.metadata); setNotice('Project metadata saved.'); setMode('view'); router.refresh();
    } catch {
      setNotice('We could not save your changes. Please try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const message = (name: string) => fieldErrors[name]?.[0];
  if (mode === 'view') return <section aria-labelledby="metadata-editor-title">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <Heading id="metadata-editor-title" className="text-base font-semibold tracking-tight text-foreground">Project information</Heading>
        <p className="mt-1 max-w-[72ch] text-sm leading-relaxed text-muted-foreground">Title, summary, background, solution, poster full text, accessibility text, year, program, disciplines and industry categories.</p>
      </div>
      {canEdit && !protectedNotice
        ? <Button type="button" className="shrink-0" onClick={() => { setNotice(null); setMode('edit'); }}><PencilLine aria-hidden="true" />Edit metadata</Button>
        : <p role="status" className="max-w-[40ch] shrink-0 text-sm text-muted-foreground sm:text-right">{protectedNotice || 'Read-only: your role cannot edit project metadata.'}</p>}
    </div>
    {notice && <p role="status" className={`mt-4 p-3 text-sm font-medium ${PROJECT_DETAIL_SURFACE_CLASSES.affirm}`}>{notice}</p>}
  </section>;

  return <section aria-labelledby="metadata-editor-title" className="-m-4 rounded-xl border-2 border-primary/40 bg-surface-subtle p-4 sm:-m-6 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Heading id="metadata-editor-title" className="text-base font-semibold tracking-tight text-foreground">Editing project information</Heading>
      {dirty && <p role="status" className={`px-2.5 py-1 text-sm font-medium ${PROJECT_DETAIL_SURFACE_CLASSES.caution}`}>Unsaved changes</p>}
    </div>
    {notice && <p id="metadata-form-error" ref={summaryRef} tabIndex={-1} role="alert" className={`mt-3 p-3 text-sm font-medium ${PROJECT_DETAIL_SURFACE_CLASSES.blocker}`}>{notice}</p>}
    <form className="mt-5 max-w-[70ch] space-y-5" onSubmit={submit} noValidate aria-describedby={notice ? 'metadata-form-error' : undefined}>
      <Field id="metadata-title" label="Project title" error={message('title')}><Input id="metadata-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-invalid={Boolean(message('title'))} aria-describedby={message('title') ? 'metadata-title-error' : undefined} /></Field>
      <Field id="metadata-summary" label="Short summary" error={message('summary')}><Textarea id="metadata-summary" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} aria-invalid={Boolean(message('summary'))} aria-describedby={message('summary') ? 'metadata-summary-error' : undefined} /></Field>
      <Field id="metadata-background" label="Problem background" error={message('background')}><Textarea id="metadata-background" value={draft.background} onChange={(e) => setDraft({ ...draft, background: e.target.value })} aria-invalid={Boolean(message('background'))} aria-describedby={message('background') ? 'metadata-background-error' : undefined} /></Field>
      <Field id="metadata-solution" label="Developed solution" error={message('solution')}><Textarea id="metadata-solution" value={draft.solution} onChange={(e) => setDraft({ ...draft, solution: e.target.value })} aria-invalid={Boolean(message('solution'))} aria-describedby={message('solution') ? 'metadata-solution-error' : undefined} /></Field>
      <Field id="metadata-poster-text" label="Poster full text" error={message('posterText')} instruction="Full text version of the meaningful content on the poster, so the published page is searchable and readable without the image. Required before this project can be submitted for review, approved, or published."><Textarea id="metadata-poster-text" rows={8} value={draft.posterText} onChange={(e) => setDraft({ ...draft, posterText: e.target.value })} aria-invalid={Boolean(message('posterText'))} aria-describedby={message('posterText') ? 'metadata-poster-text-error metadata-poster-text-instruction' : 'metadata-poster-text-instruction'} /></Field>
      <Field id="metadata-accessibility-text" label="Accessibility text" error={message('accessibilityText')} instruction="Short description of the poster image for people using a screen reader. Describe what the poster shows, not its full contents. Required before this project can be submitted for review, approved, or published."><Textarea id="metadata-accessibility-text" rows={4} value={draft.accessibilityText} onChange={(e) => setDraft({ ...draft, accessibilityText: e.target.value })} aria-invalid={Boolean(message('accessibilityText'))} aria-describedby={message('accessibilityText') ? 'metadata-accessibility-text-error metadata-accessibility-text-instruction' : 'metadata-accessibility-text-instruction'} /></Field>
      <Field id="metadata-year" label="Project year" error={message('year')}><Input id="metadata-year" inputMode="numeric" value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} aria-invalid={Boolean(message('year'))} aria-describedby={message('year') ? 'metadata-year-error' : undefined} /></Field>
      <Field id="metadata-program" label="Program" error={message('programId')}><select id="metadata-program" className={SELECT_CLASSES} value={draft.programId} onChange={(e) => setDraft({ ...draft, programId: e.target.value })} aria-invalid={Boolean(message('programId'))} aria-describedby={message('programId') ? 'metadata-program-error' : undefined}>{programs.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <Field id="metadata-disciplines" label="Disciplines" error={message('disciplineIds')} instruction="Select one or more disciplines. Use Control or Command to select multiple options."><select id="metadata-disciplines" className={MULTI_SELECT_CLASSES} multiple value={draft.disciplineIds} onChange={(e) => setDraft({ ...draft, disciplineIds: selectValues(e) })} aria-invalid={Boolean(message('disciplineIds'))} aria-describedby={message('disciplineIds') ? 'metadata-disciplines-error metadata-disciplines-instruction' : 'metadata-disciplines-instruction'}>{disciplines.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <Field id="metadata-industries" label="Industry categories" error={message('industryCategoryIds')} instruction="Select one or more industry categories. Use Control or Command to select multiple options."><select id="metadata-industries" className={MULTI_SELECT_CLASSES} multiple value={draft.industryCategoryIds} onChange={(e) => setDraft({ ...draft, industryCategoryIds: selectValues(e) })} aria-invalid={Boolean(message('industryCategoryIds'))} aria-describedby={message('industryCategoryIds') ? 'metadata-industries-error metadata-industries-instruction' : 'metadata-industries-instruction'}>{industryCategories.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5"><Button type="submit" size="lg" disabled={!editorCanSubmit(pending, dirty)} aria-busy={pending}>{pending ? 'Saving…' : 'Save metadata'}</Button><Button type="button" variant="ghost" onClick={cancel} disabled={pending}>Cancel</Button></div>
    </form>
  </section>;
}

function Field({ id, label, error, instruction, children }: { id: string; label: string; error?: string; instruction?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label htmlFor={id}>{label}</Label>{instruction && <p id={`${id}-instruction`} className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground">{instruction}</p>}{children}{error && <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive-strong">{error}</p>}</div>;
}
