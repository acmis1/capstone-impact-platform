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
  headingLevel: Heading = 'h4',
}: Props) {
  const router = useRouter();
  const { setDirty, confirmDiscard } = useProjectMetadataNavigation();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [initial, setInitial] = useState(initialMetadata);
  const [draft, setDraft] = useState(initialMetadata);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const dirty = isMetadataDirty(initial, draft);

  useEffect(() => { setDirty(dirty); return () => setDirty(false); }, [dirty, setDirty]);
  useEffect(() => { if (notice && Object.keys(fieldErrors).length > 0) summaryRef.current?.focus(); }, [notice, fieldErrors]);

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
  const protectedNotice = projectStatus === 'approved' ? 'This project is approved. Request changes before editing metadata.' : projectStatus === 'published' ? 'Published project metadata is locked until a controlled revision workflow is available.' : null;
  if (mode === 'view') return <section aria-labelledby="metadata-editor-title">
    <div className="flex items-center justify-between gap-4"><div><Heading id="metadata-editor-title" className="text-base sm:text-lg font-semibold">Project metadata</Heading><p className="text-sm text-muted-foreground">Core public project information.</p></div>{canEdit && !protectedNotice ? <Button type="button" onClick={() => { setNotice(null); setMode('edit'); }}>Edit metadata</Button> : <p role="status" className="text-sm">{protectedNotice || 'Read-only: your role cannot edit project metadata.'}</p>}</div>
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
  </section>;

  return <section aria-labelledby="metadata-editor-title"><div className="flex items-center justify-between gap-4"><div><Heading id="metadata-editor-title" className="text-base sm:text-lg font-semibold">Edit project metadata</Heading>{dirty && <p role="status" className="text-sm">Unsaved changes</p>}</div></div>
    {notice && <p id="metadata-form-error" ref={summaryRef} tabIndex={-1} role="alert" className="mt-3 text-sm">{notice}</p>}
    <form className="mt-4 space-y-4" onSubmit={submit} noValidate aria-describedby={notice ? 'metadata-form-error' : undefined}>
      <Field id="metadata-title" label="Project title" error={message('title')}><Input id="metadata-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-invalid={Boolean(message('title'))} aria-describedby={message('title') ? 'metadata-title-error' : undefined} /></Field>
      <Field id="metadata-summary" label="Short summary" error={message('summary')}><Textarea id="metadata-summary" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} aria-invalid={Boolean(message('summary'))} aria-describedby={message('summary') ? 'metadata-summary-error' : undefined} /></Field>
      <Field id="metadata-background" label="Problem background" error={message('background')}><Textarea id="metadata-background" value={draft.background} onChange={(e) => setDraft({ ...draft, background: e.target.value })} aria-invalid={Boolean(message('background'))} aria-describedby={message('background') ? 'metadata-background-error' : undefined} /></Field>
      <Field id="metadata-solution" label="Developed solution" error={message('solution')}><Textarea id="metadata-solution" value={draft.solution} onChange={(e) => setDraft({ ...draft, solution: e.target.value })} aria-invalid={Boolean(message('solution'))} aria-describedby={message('solution') ? 'metadata-solution-error' : undefined} /></Field>
      <Field id="metadata-poster-text" label="Poster full text" error={message('posterText')} instruction="Full text version of the meaningful content on the poster, so the published page is searchable and readable without the image. Required before this project can be submitted for review, approved, or published."><Textarea id="metadata-poster-text" rows={8} value={draft.posterText} onChange={(e) => setDraft({ ...draft, posterText: e.target.value })} aria-invalid={Boolean(message('posterText'))} aria-describedby={message('posterText') ? 'metadata-poster-text-error metadata-poster-text-instruction' : 'metadata-poster-text-instruction'} /></Field>
      <Field id="metadata-accessibility-text" label="Accessibility text" error={message('accessibilityText')} instruction="Short description of the poster image for people using a screen reader. Describe what the poster shows, not its full contents. Required before this project can be submitted for review, approved, or published."><Textarea id="metadata-accessibility-text" rows={4} value={draft.accessibilityText} onChange={(e) => setDraft({ ...draft, accessibilityText: e.target.value })} aria-invalid={Boolean(message('accessibilityText'))} aria-describedby={message('accessibilityText') ? 'metadata-accessibility-text-error metadata-accessibility-text-instruction' : 'metadata-accessibility-text-instruction'} /></Field>
      <Field id="metadata-year" label="Project year" error={message('year')}><Input id="metadata-year" inputMode="numeric" value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} aria-invalid={Boolean(message('year'))} aria-describedby={message('year') ? 'metadata-year-error' : undefined} /></Field>
      <Field id="metadata-program" label="Program" error={message('programId')}><select id="metadata-program" className="w-full rounded border p-2" value={draft.programId} onChange={(e) => setDraft({ ...draft, programId: e.target.value })} aria-invalid={Boolean(message('programId'))} aria-describedby={message('programId') ? 'metadata-program-error' : undefined}>{programs.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <Field id="metadata-disciplines" label="Disciplines" error={message('disciplineIds')} instruction="Select one or more disciplines. Use Control or Command to select multiple options."><select id="metadata-disciplines" className="w-full rounded border p-2" multiple value={draft.disciplineIds} onChange={(e) => setDraft({ ...draft, disciplineIds: selectValues(e) })} aria-invalid={Boolean(message('disciplineIds'))} aria-describedby={message('disciplineIds') ? 'metadata-disciplines-error metadata-disciplines-instruction' : 'metadata-disciplines-instruction'}>{disciplines.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <Field id="metadata-industries" label="Industry categories" error={message('industryCategoryIds')} instruction="Select one or more industry categories. Use Control or Command to select multiple options."><select id="metadata-industries" className="w-full rounded border p-2" multiple value={draft.industryCategoryIds} onChange={(e) => setDraft({ ...draft, industryCategoryIds: selectValues(e) })} aria-invalid={Boolean(message('industryCategoryIds'))} aria-describedby={message('industryCategoryIds') ? 'metadata-industries-error metadata-industries-instruction' : 'metadata-industries-instruction'}>{industryCategories.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <div className="flex gap-3"><Button type="submit" disabled={!editorCanSubmit(pending, dirty)} aria-busy={pending}>{pending ? 'Saving…' : 'Save metadata'}</Button><Button type="button" variant="outline" onClick={cancel} disabled={pending}>Cancel</Button></div>
    </form>
  </section>;
}

function Field({ id, label, error, instruction, children }: { id: string; label: string; error?: string; instruction?: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label htmlFor={id}>{label}</Label>{instruction && <p id={`${id}-instruction`} className="text-sm text-muted-foreground">{instruction}</p>}{children}{error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}</div>;
}
