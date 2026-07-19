import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from "../lib/supabase/adminCore";
import { executeStagingAdminBootstrap, InjectedSupabaseClient } from "../auth/stagingAdminBootstrapRunner";
import { validateBootstrapInput } from "../auth/stagingAdminBootstrap";

async function runBootstrap() {
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
    process.exitCode = 1;
    return;
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
    process.exitCode = 1;
    return;
  }

  try {
    const result = await executeStagingAdminBootstrap({
      client: supabase as unknown as InjectedSupabaseClient,
      email,
      fullName,
      confirmation
    });

    console.log(`classification=${result.classification}`);
    console.log(`provisioned=${result.provisioned}`);
    console.log(`auth_match_count=${result.authMatchCount}`);
    console.log(`pages_read=${result.pagesRead}`);
    console.log(`rpc_called=${result.rpcCalled}`);

    if (result.provisioned === 1) {
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
  } catch {
    console.log("classification=DATABASE_BOOTSTRAP_FAILURE");
    console.log("provisioned=0");
    console.log("auth_match_count=0");
    console.log("pages_read=0");
    console.log("rpc_called=NO");
    process.exitCode = 1;
  }
}

runBootstrap();
