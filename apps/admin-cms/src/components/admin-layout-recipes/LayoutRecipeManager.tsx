'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import {
  createLayoutConfigFromStock,
  HIDEABLE_LAYOUT_SECTION_IDS,
  LAYOUT_FEATURED_MEDIA,
  LAYOUT_TEMPLATE_IDS,
  resolveLayoutConfigByValue,
  type LayoutSectionId,
  type LayoutTemplateId,
  type ResolvedLayoutConfig,
} from '../../domain/layoutConfig';
import type { LayoutRecipeVersion } from '../../layout-recipes/layoutRecipes';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

const SECTION_LABELS: Record<LayoutSectionId, string> = {
  background: 'Background', solution: 'Solution', snapshots: 'Snapshots', video: 'Video',
  team: 'Team and context', links: 'Project links', citations: 'Citations', accessibilityText: 'Accessibility text',
};

const TEMPLATE_LABELS: Record<LayoutTemplateId, string> = {
  poster_showcase: 'Poster showcase', technical_detail: 'Technical detail', media_rich: 'Media rich',
};

type Notice = { variant: 'success' | 'error'; message: string } | null;

function responseError(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    if ('error' in payload && typeof payload.error === 'string') return payload.error;
    if ('message' in payload && typeof payload.message === 'string') return payload.message;
  }
  return 'The layout recipe change could not be completed. Try again.';
}

export function LayoutRecipeManager({ initialRecipes }: { initialRecipes: LayoutRecipeVersion[] }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = React.useState('');
  const [name, setName] = React.useState('');
  const [duplicateName, setDuplicateName] = React.useState('');
  const [config, setConfig] = React.useState<ResolvedLayoutConfig>(() => createLayoutConfigFromStock('poster_showcase'));
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);

  const selected = initialRecipes.find((recipe) => recipe.id === selectedId && recipe.status === 'active') ?? null;
  const activeRecipes = initialRecipes.filter((recipe) => recipe.status === 'active');

  const startNew = (templateId: LayoutTemplateId = 'poster_showcase') => {
    setSelectedId('');
    setName('');
    setDuplicateName('');
    setConfig(createLayoutConfigFromStock(templateId));
    setNotice(null);
  };

  const selectRecipe = (id: string) => {
    const recipe = activeRecipes.find((candidate) => candidate.id === id);
    if (!recipe) return startNew();
    setSelectedId(recipe.id);
    setName(recipe.name);
    setDuplicateName(`${recipe.name} copy`);
    setConfig(resolveLayoutConfigByValue(recipe.config));
    setNotice(null);
  };

  const changeTemplate = (templateId: LayoutTemplateId) => {
    const stock = createLayoutConfigFromStock(templateId);
    setConfig((current) => ({ ...stock, hiddenSections: [...current.hiddenSections] }));
  };

  const moveSection = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= config.sectionOrder.length) return;
    const sectionOrder = [...config.sectionOrder];
    [sectionOrder[index], sectionOrder[destination]] = [sectionOrder[destination], sectionOrder[index]];
    setConfig((current) => ({ ...current, sectionOrder }));
  };

  const toggleHidden = (section: typeof HIDEABLE_LAYOUT_SECTION_IDS[number]) => {
    setConfig((current) => ({
      ...current,
      hiddenSections: current.hiddenSections.includes(section)
        ? current.hiddenSections.filter((candidate) => candidate !== section)
        : [...current.hiddenSections, section],
    }));
  };

  const request = async (method: 'POST' | 'PATCH', body: unknown, successMessage: string) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/layout-recipes', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean } | null;
      if (!response.ok || !payload?.success) {
        setNotice({ variant: 'error', message: responseError(payload) });
        return;
      }
      setNotice({ variant: 'success', message: successMessage });
      router.refresh();
    } catch {
      setNotice({ variant: 'error', message: 'The layout recipe change could not be completed. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (selected) {
      void request('PATCH', {
        action: 'version', sourceVersionId: selected.id, expectedVersion: selected.version, name, config,
      }, 'A new recipe version was saved. Existing projects and previews were not changed.');
    } else {
      void request('POST', { action: 'create', name, config }, 'The reusable layout recipe was created.');
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
      <Card className="border-border-structural">
        <CardHeader>
          <CardTitle>Recipe composer</CardTitle>
          <CardDescription>Start from one of the three maintained presets, then reorder supported sections and hide optional sections. No code or free-positioned content is accepted.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {notice && <Alert variant={notice.variant === 'success' ? 'success' : 'destructive'} title={notice.variant === 'success' ? 'Updated' : 'Could not update'} description={notice.message} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-select">Edit active recipe</Label>
              <select id="recipe-select" value={selectedId} onChange={(event) => selectRecipe(event.target.value)} disabled={busy} className="flex h-10 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">New recipe</option>
                {activeRecipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name} (v{recipe.version})</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-name">Recipe name</Label>
              <Input id="recipe-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} disabled={busy} required />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-template">Maintained base preset</Label>
              <select id="recipe-template" value={config.templateId} onChange={(event) => changeTemplate(event.target.value as LayoutTemplateId)} disabled={busy} className="flex h-10 rounded-md border border-input bg-background px-3 text-sm">
                {LAYOUT_TEMPLATE_IDS.map((templateId) => <option key={templateId} value={templateId}>{TEMPLATE_LABELS[templateId]}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-featured-media">Featured media</Label>
              <select id="recipe-featured-media" value={config.featuredMedia} onChange={(event) => setConfig((current) => ({ ...current, featuredMedia: event.target.value as ResolvedLayoutConfig['featuredMedia'] }))} disabled={busy} className="flex h-10 rounded-md border border-input bg-background px-3 text-sm">
                {LAYOUT_FEATURED_MEDIA.map((media) => <option key={media} value={media}>{media}</option>)}
              </select>
            </div>
          </div>

          <fieldset className="rounded-lg border border-border/80 p-4">
            <legend className="px-1 text-sm font-semibold">Section order</legend>
            <p className="mb-3 text-xs text-muted-foreground">Use the keyboard-operable buttons to change the public detail order.</p>
            <ol className="flex flex-col gap-2">
              {config.sectionOrder.map((section, index) => (
                <li key={section} className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                  <span className="text-sm">{index + 1}. {SECTION_LABELS[section]}</span>
                  <span className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => moveSection(index, -1)} disabled={busy || index === 0} aria-label={`Move ${SECTION_LABELS[section]} up`}>Up</Button>
                    <Button variant="outline" size="sm" onClick={() => moveSection(index, 1)} disabled={busy || index === config.sectionOrder.length - 1} aria-label={`Move ${SECTION_LABELS[section]} down`}>Down</Button>
                  </span>
                </li>
              ))}
            </ol>
          </fieldset>

          <fieldset className="rounded-lg border border-border/80 p-4">
            <legend className="px-1 text-sm font-semibold">Optional visibility</legend>
            <p className="mb-3 text-xs text-muted-foreground">Team/context and accessibility equivalents are mandatory and cannot be hidden.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {HIDEABLE_LAYOUT_SECTION_IDS.map((section) => (
                <label key={section} className="flex min-h-10 items-center gap-2 rounded-md border border-border/70 px-3 py-2 text-sm">
                  <input type="checkbox" checked={config.hiddenSections.includes(section)} onChange={() => toggleHidden(section)} disabled={busy} />
                  Hide {SECTION_LABELS[section]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap gap-3">
            <Button onClick={save} disabled={busy || name.trim().length === 0} isLoading={busy}>{selected ? 'Save as new version' : 'Save new recipe'}</Button>
            <Button variant="outline" onClick={() => startNew()} disabled={busy}>Start new</Button>
            <Button variant="outline" onClick={() => router.refresh()} disabled={busy}>Reload library</Button>
          </div>

          {selected && (
            <div className="rounded-lg border border-border/80 p-4">
              <h3 className="text-sm font-semibold">Future-choice controls</h3>
              <p className="mt-1 text-xs text-muted-foreground">Versioning or retiring this recipe never rewrites a project, participant snapshot, or published feed.</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <Input aria-label="Duplicate recipe name" value={duplicateName} onChange={(event) => setDuplicateName(event.target.value)} maxLength={120} disabled={busy} />
                <Button variant="outline" onClick={() => void request('POST', { action: 'duplicate', name: duplicateName, sourceVersionId: selected.id }, 'The recipe was duplicated as a separate lineage.')} disabled={busy || duplicateName.trim().length === 0}>Duplicate</Button>
                <Button variant="destructive" onClick={() => void request('PATCH', { action: 'retire', sourceVersionId: selected.id, expectedVersion: selected.version }, 'The recipe was retired from future choices.')} disabled={busy}>Retire</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border-structural">
          <CardHeader><CardTitle>Version history</CardTitle><CardDescription>{initialRecipes.length} immutable saved {initialRecipes.length === 1 ? 'version' : 'versions'}.</CardDescription></CardHeader>
        <CardContent>
          <ul className="divide-y divide-border/70 rounded-lg border border-border/70" aria-label="Layout recipe version history">
            {initialRecipes.map((recipe) => (
              <li key={recipe.id} className="px-3 py-3 text-sm">
                <p className="font-medium text-foreground">{recipe.name} · v{recipe.version}</p>
                <p className="mt-1 text-xs text-muted-foreground">{recipe.status} · {TEMPLATE_LABELS[recipe.config.templateId]}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
