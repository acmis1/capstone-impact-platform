'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { MetadataOption, ProjectMetadataActionResult, ProjectMetadataView, projectMetadataInputSchema } from '../../projects/projectMetadata';
import { editorCanSubmit, isMetadataDirty } from './projectMetadataEditorState';

interface Props {
  initialMetadata: ProjectMetadataView;
  programs: MetadataOption[];
  disciplines: MetadataOption[];
  industryCategories: MetadataOption[];
  canEdit: boolean;
  saveAction: (input: unknown) => Promise<ProjectMetadataActionResult>;
}

const selectValues = (event: React.ChangeEvent<HTMLSelectElement>) => Array.from(event.currentTarget.selectedOptions, (option) => option.value);

export function ProjectMetadataEditor({ initialMetadata, programs, disciplines, industryCategories, canEdit, saveAction }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [initial, setInitial] = useState(initialMetadata);
  const [draft, setDraft] = useState(initialMetadata);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = isMetadataDirty(initial, draft);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const cancel = () => {
    if (dirty && !window.confirm('Discard your unsaved metadata changes?')) return;
    setDraft(initial); setFieldErrors({}); setNotice(null); setMode('view');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editorCanSubmit(pending, dirty)) return;
    const local = projectMetadataInputSchema.safeParse(draft);
    if (!local.success) { setFieldErrors(local.error.flatten().fieldErrors); setNotice('Review the highlighted fields and try again.'); return; }
    setPending(true); setFieldErrors({}); setNotice(null);
    const result = await saveAction(draft);
    setPending(false);
    if (!result.ok) { setFieldErrors(result.fieldErrors || {}); setNotice(result.message); return; }
    setInitial(result.metadata); setDraft(result.metadata); setNotice('Project metadata saved.'); setMode('view'); router.refresh();
  };

  const message = (name: string) => fieldErrors[name]?.[0];
  if (mode === 'view') return <section aria-labelledby="metadata-editor-title">
    <div className="flex items-center justify-between gap-4"><div><h2 id="metadata-editor-title" className="text-lg font-semibold">Project metadata</h2><p className="text-sm text-muted-foreground">Core public project information.</p></div>{canEdit ? <Button type="button" onClick={() => { setNotice(null); setMode('edit'); }}>Edit metadata</Button> : <p role="status" className="text-sm">Read-only: your role cannot edit project metadata.</p>}</div>
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
  </section>;

  return <section aria-labelledby="metadata-editor-title"><div className="flex items-center justify-between gap-4"><div><h2 id="metadata-editor-title" className="text-lg font-semibold">Edit project metadata</h2>{dirty && <p role="status" className="text-sm">Unsaved changes</p>}</div></div>
    {notice && <p role="alert" className="mt-3 text-sm">{notice}</p>}
    <form className="mt-4 space-y-4" onSubmit={submit} noValidate>
      <Field label="Project title" error={message('title')}><Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-invalid={Boolean(message('title'))} /></Field>
      <Field label="Short summary" error={message('summary')}><Textarea value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} aria-invalid={Boolean(message('summary'))} /></Field>
      <Field label="Problem background" error={message('background')}><Textarea value={draft.background} onChange={(e) => setDraft({ ...draft, background: e.target.value })} aria-invalid={Boolean(message('background'))} /></Field>
      <Field label="Developed solution" error={message('solution')}><Textarea value={draft.solution} onChange={(e) => setDraft({ ...draft, solution: e.target.value })} aria-invalid={Boolean(message('solution'))} /></Field>
      <Field label="Project year" error={message('year')}><Input inputMode="numeric" value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} aria-invalid={Boolean(message('year'))} /></Field>
      <Field label="Program" error={message('programId')}><select className="w-full rounded border p-2" value={draft.programId} onChange={(e) => setDraft({ ...draft, programId: e.target.value })}>{programs.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <Field label="Disciplines" error={message('disciplineIds')}><select className="w-full rounded border p-2" multiple value={draft.disciplineIds} onChange={(e) => setDraft({ ...draft, disciplineIds: selectValues(e) })}>{disciplines.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <Field label="Industry categories" error={message('industryCategoryIds')}><select className="w-full rounded border p-2" multiple value={draft.industryCategoryIds} onChange={(e) => setDraft({ ...draft, industryCategoryIds: selectValues(e) })}>{industryCategories.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <div className="flex gap-3"><Button type="submit" disabled={!editorCanSubmit(pending, dirty)}>{pending ? 'Saving…' : 'Save metadata'}</Button><Button type="button" variant="outline" onClick={cancel} disabled={pending}>Cancel</Button></div>
    </form>
  </section>;
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label>{label}</Label>{children}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>;
}
