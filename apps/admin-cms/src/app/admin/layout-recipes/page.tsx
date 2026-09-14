import React from 'react';
import { requireAdmin } from '../../../auth/requireAdmin';
import { canManageTaxonomy } from '../../../auth/permissions';
import { createSupabaseAdminClient } from '../../../lib/supabase/admin';
import { ErrorState } from '../../../components/ui/error-state';
import { LayoutRecipeManager } from '../../../components/admin-layout-recipes/LayoutRecipeManager';
import { SupabaseLayoutRecipeGateway } from '../../../layout-recipes/SupabaseLayoutRecipeGateway';

export const dynamic = 'force-dynamic';

export default async function LayoutRecipesPage() {
  const adminContext = await requireAdmin();
  if (!canManageTaxonomy(adminContext.permissions)) {
    return <ErrorState title="Access denied" description="Your account cannot manage layout recipes." headingLevel="h1" />;
  }

  let recipes = null;
  try {
    recipes = await new SupabaseLayoutRecipeGateway(createSupabaseAdminClient()).list();
  } catch {
    console.error('[Layout recipes page]: LIBRARY_LOAD_FAILED');
  }
  if (!recipes) {
    return <ErrorState title="Layout recipes unavailable" description="The shared recipe library could not be loaded. Try again shortly." headingLevel="h1" />;
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Layout recipes</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Compose named, reusable arrangements from maintained showcase primitives. Applying a recipe copies its resolved values into a future project package.</p>
      </header>
      <LayoutRecipeManager initialRecipes={recipes} />
    </div>
  );
}
