import React from 'react';
import { requireAdmin } from '../../../auth/requireAdmin';
import { canManageTaxonomy } from '../../../auth/permissions';
import { createSupabaseAdminClient } from '../../../lib/supabase/admin';
import { ErrorState } from '../../../components/ui/error-state';
import { TaxonomyManager } from '../../../components/admin-taxonomy/TaxonomyManager';
import { SupabaseTaxonomyGateway } from '../../../taxonomy/SupabaseTaxonomyGateway';

export const dynamic = 'force-dynamic';

/** Authorized School-operator surface for the existing project lookup catalogues. */
export default async function TaxonomyPage() {
  const adminContext = await requireAdmin();
  if (!canManageTaxonomy(adminContext.permissions)) {
    return (
      <ErrorState
        title="Access denied"
        description="Your account cannot manage project categories."
        headingLevel="h1"
      />
    );
  }

  let catalogues: Awaited<ReturnType<SupabaseTaxonomyGateway['list']>> | null = null;
  try {
    catalogues = await new SupabaseTaxonomyGateway(createSupabaseAdminClient()).list();
  } catch {
    console.error('[Taxonomy Page]: CATALOGUE_LOAD_FAILED');
  }

  if (!catalogues) {
    return (
      <ErrorState
        title="Project categories unavailable"
        description="The project category catalogue could not be loaded. Try again shortly."
        headingLevel="h1"
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Project categories</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Add official School catalogue values here. Existing values are retained to protect projects that may already reference them.
        </p>
      </header>
      <TaxonomyManager initialCatalogues={catalogues} />
    </div>
  );
}
