'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import {
  createLayoutConfigFromStock,
  HIDEABLE_LAYOUT_SECTION_IDS,
  LAYOUT_FEATURED_MEDIA,
  LAYOUT_TEMPLATE_IDS,
  resolveLayoutConfigByValue,
  type LayoutTemplateId,
  type ResolvedLayoutConfig,
} from '../../domain/layoutConfig';
import {
  FEATURED_MEDIA_PRESENTATION,
  LAYOUT_SECTION_PRESENTATION,
  LAYOUT_TEMPLATE_PRESENTATION,
} from '../../domain/layoutPresentation';
import type { LayoutRecipeVersion } from '../../layout-recipes/layoutRecipes';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { LayoutRecipePreview } from './LayoutRecipePreview';
import { useUnsavedWorkGuard } from '../ui/unsaved-work';

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
  const [recipes, setRecipes] = React.useState(initialRecipes);
  const [lastServerRecipes, setLastServerRecipes] = React.useState(initialRecipes);
  const [selectedId, setSelectedId] = React.useState('');
  const [name, setName] = React.useState('');
  const [duplicateName, setDuplicateName] = React.useState('');
  const [config, setConfig] = React.useState<ResolvedLayoutConfig>(() => createLayoutConfigFromStock('poster_showcase'));
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const requestInFlight = React.useRef(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [unknownWriteOutcome, setUnknownWriteOutcome] = React.useState(false);
  const [syncingVersionId, setSyncingVersionId] = React.useState<string | null>(null);

  const selected = recipes.find((recipe) => recipe.id === selectedId && recipe.status === 'active') ?? null;
  const activeRecipes = recipes.filter((recipe) => recipe.status === 'active');

  const navigate = React.useCallback((href: string) => router.push(href), [router]);
  const { requestAction, dialog } = useUnsavedWorkGuard({
    dirty,
    onDiscard: () => setDirty(false),
    navigate,
  });

  // Guarded same-component adjustment follows a new RSC snapshot, without an effect loop.
  // Never overwrite an unsaved draft; a known saved ID is adopted only from returned server data.
  if (lastServerRecipes !== initialRecipes) {
    setLastServerRecipes(initialRecipes);
    if (!dirty || syncingVersionId) {
      setRecipes(initialRecipes);
      const saved = syncingVersionId
        ? initialRecipes.find(recipe => recipe.id === syncingVersionId)
        : null;
      if (saved) {
        setSelectedId(saved.id);
        setName(saved.name);
        setDuplicateName(saved.name + ' copy');
        setConfig(resolveLayoutConfigByValue(saved.config));
        setSyncingVersionId(null);
        setDirty(false);
      }
    }
  }

  const applyStartNew = (templateId: LayoutTemplateId = 'poster_showcase', clearNotice = true) => {
    setSelectedId('');
    setName('');
    setDuplicateName('');
    setConfig(createLayoutConfigFromStock(templateId));
    if (clearNotice) setNotice(null);
    setDirty(false);
  };

  const startNew = (templateId: LayoutTemplateId = 'poster_showcase', trigger?: HTMLElement | null) => {
    requestAction(() => applyStartNew(templateId), {
      trigger,
      description: 'Your current recipe draft will be lost. Start a new recipe from a maintained preset?',
      confirmLabel: 'Start new recipe',
    });
  };

  const applyRecipe = (recipe: LayoutRecipeVersion) => {
    setSelectedId(recipe.id);
    setName(recipe.name);
    setDuplicateName(`${recipe.name} copy`);
    setConfig(resolveLayoutConfigByValue(recipe.config));
    setNotice(null);
    setDirty(false);
  };

  const selectRecipe = (id: string, trigger?: HTMLElement | null) => {
    const recipe = activeRecipes.find((candidate) => candidate.id === id);
    if (!recipe) {
      startNew('poster_showcase', trigger);
      return;
    }
    requestAction(() => applyRecipe(recipe), {
      trigger,
      description: 'Your current recipe draft will be replaced by the saved recipe version.',
    });
  };

  const changeTemplate = (templateId: LayoutTemplateId, trigger?: HTMLElement | null) => {
    if (templateId === config.templateId) return;
    const stock = createLayoutConfigFromStock(templateId);
    requestAction(() => {
      setConfig(stock);
      // Changing a preset edits this lineage; it does not silently create a new recipe.
      setDirty(true);
    }, {
      forceConfirmation: true,
      trigger,
      title: `Reset to ${LAYOUT_TEMPLATE_PRESENTATION[templateId].label}?`,
      description: 'Changing the base preset resets the featured media, section order, and optional visibility to that maintained preset.',
      confirmLabel: 'Reset layout choices',
    });
  };

  const moveSection = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= config.sectionOrder.length) return;
    const sectionOrder = [...config.sectionOrder];
    [sectionOrder[index], sectionOrder[destination]] = [sectionOrder[destination], sectionOrder[index]];
    setConfig((current) => ({ ...current, sectionOrder }));
    setDirty(true);
  };

  const toggleHidden = (section: typeof HIDEABLE_LAYOUT_SECTION_IDS[number]) => {
    setConfig((current) => ({
      ...current,
      hiddenSections: current.hiddenSections.includes(section)
        ? current.hiddenSections.filter((candidate) => candidate !== section)
        : [...current.hiddenSections, section],
    }));
    setDirty(true);
  };

  const request = async (method: 'POST' | 'PATCH', body: unknown, successMessage: string) => {
    if (requestInFlight.current || busy || unknownWriteOutcome || syncingVersionId) return;
    requestInFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/layout-recipes', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; recipeVersionId?: unknown; code?: string } | null;
      if (!response.ok || !payload?.success) {
        if (payload?.code === 'PERSISTENCE_FAILED' || response.status >= 500 || response.ok || !payload || payload.success !== false) {
          setUnknownWriteOutcome(true);
          setNotice({ variant: 'error', message: 'The write outcome is unknown. Reload the library before trying again; do not retry yet.' });
          return;
        }
        setNotice({ variant: 'error', message: responseError(payload) });
        return;
      }
      if (typeof payload.recipeVersionId !== 'string' || payload.recipeVersionId.length === 0) {
        setUnknownWriteOutcome(true);
        setNotice({ variant: 'error', message: 'The write outcome is unknown. Reload the library before trying again; do not retry yet.' });
        return;
      }
      setNotice({ variant: 'success', message: successMessage });
      setUnknownWriteOutcome(false);
      setDirty(false);
      if (body && typeof body === 'object' && 'action' in body && body.action === 'retire') {
        applyStartNew('poster_showcase', false);
      } else {
        setSelectedId(payload.recipeVersionId);
        setSyncingVersionId(payload.recipeVersionId);
      }
      router.refresh();
    } catch {
      setUnknownWriteOutcome(true);
      setNotice({ variant: 'error', message: 'The write outcome is unknown. Reload the library before trying again; do not retry yet.' });
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  const save = () => {
    if (unknownWriteOutcome || syncingVersionId) return;
    if (selected) {
      void request('PATCH', {
        action: 'version', sourceVersionId: selected.id, expectedVersion: selected.version, name, config,
      }, 'A new recipe version was saved. Existing projects and previews were not changed.');
    } else {
      void request('POST', { action: 'create', name, config }, 'The reusable layout recipe was created.');
    }
  };

  const reloadLibrary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/layout-recipes', { headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => null) as { success?: boolean; recipes?: LayoutRecipeVersion[] } | null;
      if (!response.ok || !payload?.success || !Array.isArray(payload.recipes)) {
        setNotice({ variant: 'error', message: 'The current recipe library could not be reloaded. No draft was changed.' });
        return;
      }
      // The read API returns active choices. Retain immutable historical rows until the full RSC refresh.
      const nextRecipes = payload.recipes;
      if (nextRecipes.some(recipe => !recipe || typeof recipe.id !== 'string' || recipe.status !== 'active')) throw new Error('INVALID_RECIPE_LIBRARY');
      for (const recipe of nextRecipes) resolveLayoutConfigByValue(recipe.config);
      setRecipes(previous => [...previous.filter(recipe => recipe.status !== 'active' && !nextRecipes.some(next => next.id === recipe.id)), ...nextRecipes]);
      const current = nextRecipes.find((recipe) => recipe.id === selectedId && recipe.status === 'active');
      if (current) applyRecipe(current);
      else applyStartNew();
      setUnknownWriteOutcome(false);
      setSyncingVersionId(null);
      setNotice({ variant: 'success', message: 'The recipe library was reconciled with the current server state.' });
      router.refresh();
    } catch {
      setNotice({ variant: 'error', message: 'The current recipe library could not be reloaded. No draft was changed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
      <Card className="border-border-structural">
        <CardHeader>
          <CardTitle>Recipe composer</CardTitle>
          <CardDescription>Start from one of the three maintained presets, then reorder supported sections and hide optional sections. No code, SVG, HTML, external media, or free-positioned content is accepted.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {notice && <Alert variant={notice.variant === 'success' ? 'success' : 'destructive'} title={notice.variant === 'success' ? 'Updated' : 'Could not update'} description={notice.message} />}
          {unknownWriteOutcome && <Alert variant="destructive" title="Reload required before retry" description="The last network/write outcome is unknown. Reload library to reconcile server state before attempting another write." />}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-select">Edit active recipe</Label>
              <select id="recipe-select" value={selectedId} onChange={(event) => { event.preventDefault(); event.stopPropagation(); selectRecipe(event.target.value, event.currentTarget); }} disabled={busy || Boolean(syncingVersionId)} className="flex h-10 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">New recipe</option>
                {activeRecipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name} (v{recipe.version})</option>)}
              </select>
              <p className="text-xs text-muted-foreground">Selecting another saved version replaces the current draft after confirmation.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-name">Recipe name</Label>
              <Input id="recipe-name" value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} maxLength={120} disabled={busy || Boolean(syncingVersionId)} required />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-template">Maintained base preset</Label>
              <select id="recipe-template" value={config.templateId} onChange={(event) => { event.preventDefault(); event.stopPropagation(); changeTemplate(event.target.value as LayoutTemplateId, event.currentTarget); }} disabled={busy || Boolean(syncingVersionId)} className="flex h-10 rounded-md border border-input bg-background px-3 text-sm">
                {LAYOUT_TEMPLATE_IDS.map((templateId) => <option key={templateId} value={templateId}>{LAYOUT_TEMPLATE_PRESENTATION[templateId].label}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">{LAYOUT_TEMPLATE_PRESENTATION[config.templateId].description} Changing it resets order, feature, and optional visibility.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recipe-featured-media">Featured media</Label>
              <select id="recipe-featured-media" value={config.featuredMedia} onChange={(event) => { setConfig((current) => ({ ...current, featuredMedia: event.target.value as ResolvedLayoutConfig['featuredMedia'] })); setDirty(true); }} disabled={busy || Boolean(syncingVersionId)} className="flex h-10 rounded-md border border-input bg-background px-3 text-sm">
                {LAYOUT_FEATURED_MEDIA.map((media) => <option key={media} value={media}>{FEATURED_MEDIA_PRESENTATION[media]}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">Featuring video or the snapshot gallery pulls that media out of ordinary order; absent media uses the effective fallback shown below.</p>
            </div>
          </div>

          <div className="rounded-lg border border-border/80 bg-muted/20 p-4 text-sm">
            <p className="font-semibold text-foreground">Fixed and optional regions</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Required title, summary, metadata, and poster regions stay fixed. A supplied snapshot gallery cannot be hidden. Team &amp; group and the poster accessibility description remain visible. Optional fields may be absent. Poster transcript and poster alt text are distinct.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {Object.entries(LAYOUT_SECTION_PRESENTATION).map(([section, presentation]) => <p key={section} className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{presentation.label}:</span> {presentation.helper}</p>)}
            </div>
          </div>

          <fieldset className="rounded-lg border border-border/80 p-4">
            <legend className="px-1 text-sm font-semibold">Section order</legend>
            <p className="mb-3 text-xs text-muted-foreground">Use the keyboard-operable buttons to change optional content order. Fixed regions remain fixed, and featured media is pulled out of this order.</p>
            <ol className="flex flex-col gap-2">
              {config.sectionOrder.map((section, index) => (
                <li key={section} className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                  <span className="text-sm">{index + 1}. {LAYOUT_SECTION_PRESENTATION[section].label}</span>
                  <span className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => moveSection(index, -1)} disabled={busy || Boolean(syncingVersionId) || index === 0} aria-label={`Move ${LAYOUT_SECTION_PRESENTATION[section].label} up`}>Up</Button>
                    <Button variant="outline" size="sm" onClick={() => moveSection(index, 1)} disabled={busy || Boolean(syncingVersionId) || index === config.sectionOrder.length - 1} aria-label={`Move ${LAYOUT_SECTION_PRESENTATION[section].label} down`}>Down</Button>
                  </span>
                </li>
              ))}
            </ol>
          </fieldset>

          <fieldset className="rounded-lg border border-border/80 p-4">
            <legend className="px-1 text-sm font-semibold">Optional visibility</legend>
            <p className="mb-3 text-xs text-muted-foreground">Snapshots/gallery, Team &amp; group, and Poster accessibility description are fixed and cannot be hidden.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {HIDEABLE_LAYOUT_SECTION_IDS.map((section) => (
                <label key={section} className="flex min-h-10 items-center gap-2 rounded-md border border-border/70 px-3 py-2 text-sm">
                  <input type="checkbox" checked={config.hiddenSections.includes(section)} onChange={() => toggleHidden(section)} disabled={busy || Boolean(syncingVersionId)} />
                  Hide {LAYOUT_SECTION_PRESENTATION[section].label}
                </label>
              ))}
            </div>
          </fieldset>

          <LayoutRecipePreview config={config} />

          <div className="flex flex-wrap gap-3">
            <Button onClick={save} disabled={busy || unknownWriteOutcome || Boolean(syncingVersionId) || name.trim().length === 0} isLoading={busy}>{syncingVersionId ? 'Syncing saved version…' : selected ? 'Save as new version' : 'Save new recipe'}</Button>
            <Button variant="outline" onClick={(event) => startNew('poster_showcase', event.currentTarget)} disabled={busy || Boolean(syncingVersionId)}>Start new</Button>
            <Button variant="outline" onClick={() => requestAction(() => void reloadLibrary(), { description: 'Reloading the library replaces the current recipe draft with the current server state.', confirmLabel: 'Reload library' })} disabled={busy}>Reload library</Button>
          </div>

          {selected && (
            <div className="rounded-lg border border-border/80 p-4">
              <h3 className="text-sm font-semibold">Future-choice controls</h3>
              <p className="mt-1 text-xs text-muted-foreground">Duplicate copies this saved recipe version, not the current draft. Save the draft as a new version first if its configuration should be copied. Versioning or retiring never rewrites a project, participant snapshot, or published feed.</p>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <Input aria-label="Duplicate saved recipe name" value={duplicateName} onChange={(event) => setDuplicateName(event.target.value)} maxLength={120} disabled={busy || unknownWriteOutcome} />
                <Button variant="outline" onClick={() => {
                  if (dirty) {
                    setNotice({ variant: 'error', message: 'Save this draft as a new version before duplicating. Duplicate always copies the saved recipe version.' });
                    return;
                  }
                  void request('POST', { action: 'duplicate', name: duplicateName, sourceVersionId: selected.id }, 'The recipe was duplicated as a separate lineage.');
                }} disabled={busy || unknownWriteOutcome || duplicateName.trim().length === 0}>Duplicate saved version</Button>
                <Button variant="destructive" onClick={(event) => requestAction(
                  () => void request('PATCH', { action: 'retire', sourceVersionId: selected.id, expectedVersion: selected.version }, 'The recipe was retired from future choices. Version history is retained.'),
                  {
                    forceConfirmation: true,
                    trigger: event.currentTarget,
                    title: `Retire “${selected.name}” v${selected.version}?`,
                    description: `This retires the exact saved recipe version “${selected.name}” v${selected.version} from future choices. Existing projects are unchanged, and version history is retained for audit and recovery. Any unsaved draft changes will also be discarded.`,
                    confirmLabel: 'Retire recipe version',
                  },
                )} disabled={busy || unknownWriteOutcome}>Retire recipe version</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border-structural">
          <CardHeader><CardTitle>Version history</CardTitle><CardDescription>{recipes.length} immutable saved {recipes.length === 1 ? 'version' : 'versions'}.</CardDescription></CardHeader>
        <CardContent>
          <ul className="divide-y divide-border/70 rounded-lg border border-border/70" aria-label="Layout recipe version history">
            {recipes.map((recipe) => (
              <li key={recipe.id} className="px-3 py-3 text-sm">
                <p className="font-medium text-foreground">{recipe.name} · v{recipe.version}</p>
                <p className="mt-1 text-xs text-muted-foreground">{recipe.status} · {LAYOUT_TEMPLATE_PRESENTATION[recipe.config.templateId].label}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {dialog}
    </div>
  );
}
