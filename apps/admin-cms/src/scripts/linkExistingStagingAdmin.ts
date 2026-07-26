import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from "../lib/supabase/adminCore";
import { executeStagingAdminBootstrap, InjectedSupabaseClient } from "../auth/stagingAdminBootstrapRunner";
import { validateBootstrapInput } from "../auth/stagingAdminBootstrap";
import { validateStagingGuard } from "../security/stagingExecutionGuard";

export async function runLinkExistingStagingAdmin(args?: string[]): Promise<boolean> {
  const guard = validateStagingGuard({ operationId: 'link-existing-staging-admin', args });

  if (!guard.isAuthorized) {
    console.log(`[DRY-RUN] ${guard.dryRunReason}`);
    console.log('[DRY-RUN] Planned operation: Link Auth user identity to admin_users profile record.');
    return false;
  }

  const email = process.env.CAPSTONE_BOOTSTRAP_ADMIN_EMAIL;
  const fullName = process.env.CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME;
  const confirmation = process.env.CAPSTONE_BOOTSTRAP_CONFIRM;

  // Perform validation first before initializing database clients
  const validation = validateBootstrapInput({ email, fullName, confirmation });
  if (!validation.isValid) {
    console.log(`classification=${validation.error || "SAFE_PRECONDITION_FAILURE"}`);
    console.log("provisioned=0");
    console.log("auth_match_count=0");
    console.log("pages_read=0");
    console.log("rpc_called=NO");
    return false;
  }

  let supabase;
  try {
    supabase = createSupabaseAdminClientCore();
  } catch {
    console.log("classification=SAFE_PRECONDITION_FAILURE");
    console.log("provisioned=0");
    console.log("auth_match_count=0");
    console.log("pages_read=0");
    console.log("rpc_called=NO");
    return false;
  }

  try {
    const result = await executeStagingAdminBootstrap({
      client: supabase as unknown as InjectedSupabaseClient,
      email,
      fullName,
      confirmation,
    });

    console.log(`classification=${result.classification}`);
    console.log(`provisioned=${result.provisioned}`);
    console.log(`auth_match_count=${result.authMatchCount}`);
    console.log(`pages_read=${result.pagesRead}`);
    console.log(`rpc_called=${result.rpcCalled}`);

    return result.provisioned === 1;
  } catch {
    console.log("classification=DATABASE_BOOTSTRAP_FAILURE");
    console.log("provisioned=0");
    console.log("auth_match_count=0");
    console.log("pages_read=0");
    console.log("rpc_called=NO");
    return false;
  }
}

if (require.main === module) {
  runLinkExistingStagingAdmin().then((success) => {
    if (!success) process.exit(1);
  }).catch((err) => {
    console.error('❌ Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
