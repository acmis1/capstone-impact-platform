'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { useUnsavedWorkGuard } from '../ui/unsaved-work';
import { LayoutRecipePreview } from '../admin-layout-recipes/LayoutRecipePreview';
import { createLayoutConfigFromStock, LAYOUT_TEMPLATE_IDS, resolveLayoutConfigByValue, type ResolvedLayoutConfig } from '../../domain/layoutConfig';
import { featuredMediaLabel, layoutSectionList, layoutTemplateLabel } from '../../domain/projectRecordPresentation';
import { parseProjectLayoutMaintenanceResponse } from '../../projects/projectLayoutMaintenanceResponse';
import type { LayoutRecipeVersion } from '../../layout-recipes/layoutRecipes';

type Notice = { variant: 'success' | 'destructive' | 'warning'; message: string } | null;
function diffSummary(before: ResolvedLayoutConfig, after: ResolvedLayoutConfig): string[] {
  const changes: string[] = [];
  if (before.templateId !== after.templateId) changes.push(`Preset: ${layoutTemplateLabel(before.templateId)} to ${layoutTemplateLabel(after.templateId)}`);
  if (before.featuredMedia !== after.featuredMedia) changes.push(`Featured media: ${featuredMediaLabel(before.featuredMedia)} to ${featuredMediaLabel(after.featuredMedia)}`);
  if (before.sectionOrder.join('|') !== after.sectionOrder.join('|')) changes.push(`Section order: ${layoutSectionList(after.sectionOrder)}`);
  if (before.hiddenSections.join('|') !== after.hiddenSections.join('|')) changes.push(`Hidden sections: ${layoutSectionList(after.hiddenSections)}`);
  return changes;
}
function refusalMessage(code: unknown): string {
  if (code === 'STALE_VERSION') return 'This project changed in another session. Reload before trying again.';
  if (code === 'RECIPE_VERSION_INACTIVE_OR_CHANGED') return 'The saved recipe is no longer active. Reload the current choices.';
  if (code === 'LAYOUT_STATUS_INELIGIBLE') return 'Only private Draft or Changes requested projects can change layout.';
  if (code === 'LAYOUT_EVIDENCE_INVALID') return 'The previous layout lacks valid evidence. A corrected project package is required.';
  return 'The layout change was refused. Check the project workflow and current readiness, then reload.';
}

export function ProjectLayoutMaintenanceEditor({ publicId, expectedUpdatedAt, initialConfig, recipes }: {
  publicId: string; expectedUpdatedAt: string; initialConfig: ResolvedLayoutConfig; recipes: LayoutRecipeVersion[];
}) {
  const router = useRouter();
  const [baseline, setBaseline] = React.useState(initialConfig);
  const [config, setConfig] = React.useState(initialConfig);
  const [expected, setExpected] = React.useState(expectedUpdatedAt);
  const [observed, setObserved] = React.useState(`${publicId}:${expectedUpdatedAt}`);
  const [recipeVersionId, setRecipeVersionId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reloadRequired, setReloadRequired] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const inFlight = React.useRef(false);
  const differences = diffSummary(baseline, config);
  const dirty = differences.length > 0;
  const incoming = `${publicId}:${expectedUpdatedAt}`;
  if (incoming !== observed) {
    setObserved(incoming);
    if (dirty || reloadRequired) {
      setReloadRequired(true);
      setNotice({ variant: 'warning', message: 'The project changed while you were editing. Your draft is retained; reload before saving.' });
    } else {
      setBaseline(initialConfig); setConfig(initialConfig); setExpected(expectedUpdatedAt); setRecipeVersionId(null);
    }
  }
  const navigate = React.useCallback((href: string) => router.push(href), [router]);
  const { requestAction, dialog } = useUnsavedWorkGuard({
    dirty, navigate, onDiscard: () => { setConfig(baseline); setRecipeVersionId(null); },
  });
  const chooseRecipe = (id: string) => {
    if (busy || reloadRequired) return;
    if (id === '') { setConfig(createLayoutConfigFromStock(config.templateId)); setRecipeVersionId(null); return; }
    const recipe = recipes.find(item => item.id === id && item.status === 'active');
    if (!recipe) return;
    setConfig(resolveLayoutConfigByValue(recipe.config)); setRecipeVersionId(recipe.id); setNotice(null);
  };
  const save = async () => {
    if (inFlight.current || busy || reloadRequired || !dirty) return;
    inFlight.current = true; setBusy(true); setConfirmOpen(false); setNotice(null);
    const submittedConfig = resolveLayoutConfigByValue(config);
    const unknownOutcome = () => {
      setReloadRequired(true);
      setNotice({ variant: 'warning', message: 'The write outcome is unknown. Reload the project to check server state before trying again.' });
    };
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/layout`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicId, expectedUpdatedAt: expected, layoutConfig: submittedConfig, recipeVersionId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || response.status >= 500) { unknownOutcome(); return; }
      const { success, ...body } = payload as Record<string, unknown>;
      if (!response.ok) {
        if (success !== false) { unknownOutcome(); return; }
        if (body.resultCode === 'STALE_VERSION') setReloadRequired(true);
        setNotice({ variant: 'destructive', message: refusalMessage(body.resultCode) });
        return;
      }
      if (success !== true) { unknownOutcome(); return; }
      const result = parseProjectLayoutMaintenanceResponse(body, publicId);
      if (result.resultCode !== 'UPDATED' && result.resultCode !== 'UNCHANGED') { unknownOutcome(); return; }
      if (result.resultCode === 'UPDATED' && 'updatedAt' in result && 'revokedActivePreviewCount' in result) {
        setExpected(result.updatedAt);
        setNotice({ variant: 'success', message: `Layout saved. ${result.revokedActivePreviewCount} active participant preview revoked. Participant content and physical media were retained; nothing was published.` });
      } else setNotice({ variant: 'success', message: 'The server already has this layout. No change or preview revocation was performed.' });
      setBaseline(submittedConfig); setConfig(submittedConfig); router.refresh();
    } catch { unknownOutcome(); }
    finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">Only the layout of this private Draft or Changes requested project will change. Participant-owned text and physical media are retained. This is not a publication action.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Stock layout choices">
        {LAYOUT_TEMPLATE_IDS.map(template => <Button key={template} type="button" variant={config.templateId === template && recipeVersionId === null ? 'default' : 'outline'} disabled={busy || reloadRequired} onClick={() => { setConfig(createLayoutConfigFromStock(template)); setRecipeVersionId(null); setNotice(null); }}>{layoutTemplateLabel(template)}</Button>)}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-layout-recipe">Apply active saved recipe by value</Label>
        <select id="project-layout-recipe" value={recipeVersionId ?? ''} onChange={event => chooseRecipe(event.target.value)} disabled={busy || reloadRequired} className="min-h-11 rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Stock configuration</option>
          {recipes.filter(recipe => recipe.status === 'active').map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.name} · v{recipe.version}</option>)}
        </select>
      </div>
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <p className="text-sm font-semibold">Exact change summary</p>
        {!dirty ? <p className="mt-1 text-sm text-muted-foreground">No changes to save.</p> : <><p className="mt-1 text-sm font-medium">Unsaved layout changes</p><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{differences.map(change => <li key={change}>{change}</li>)}</ul></>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || reloadRequired || !dirty} onClick={() => setConfirmOpen(true)}>{busy ? 'Saving…' : 'Save layout configuration'}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => requestAction(() => window.location.reload(), { confirmLabel: 'Reload project', description: 'Reload the current server record. Unsaved layout choices will be discarded.' })}>Reload project</Button>
      </div>
      {notice && <Alert variant={notice.variant} title={notice.variant === 'success' ? 'Layout maintenance' : notice.variant === 'warning' ? 'Reload required' : 'Layout not changed'} description={notice.message} />}
      <LayoutRecipePreview config={config} />
      {dialog}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent><AlertDialogHeader>
          <AlertDialogTitle>Save layout for {publicId}?</AlertDialogTitle>
          <AlertDialogDescription>This saves the exact choices shown above. Any active participant preview will be revoked; its historical snapshot and responses remain retained. The project stays private and must follow the normal review and confirmation workflow before publication.</AlertDialogDescription>
        </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction onClick={() => void save()} disabled={busy || reloadRequired}>Confirm layout change</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
