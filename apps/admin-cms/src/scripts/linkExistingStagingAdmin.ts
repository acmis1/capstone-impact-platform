import "server-only";
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { User } from "@supabase/supabase-js";
import { createSupabaseAdminClientCore } from "../lib/supabase/adminCore";
import { validateBootstrapInput, mapRpcResponse, mapDatabaseError } from "../auth/stagingAdminBootstrap";

async function runBootstrap() {
  const email = process.env.CAPSTONE_BOOTSTRAP_ADMIN_EMAIL;
  const fullName = process.env.CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME;
  const confirmation = process.env.CAPSTONE_BOOTSTRAP_CONFIRM;

  const validation = validateBootstrapInput({ email, fullName, confirmation });

  if (!validation.isValid) {
    console.log(`classification=${validation.error}`);
    console.log("provisioned=0");
    process.exit(1);
  }

  const { normalizedEmail, normalizedFullName } = validation;

  let supabase;
  try {
    supabase = createSupabaseAdminClientCore();
  } catch {
    console.log("classification=SAFE_PRECONDITION_FAILURE");
    console.log("provisioned=0");
    process.exit(1);
  }

  try {
    let page = 1;
    const perPage = 100;
    const matchingUsers: User[] = [];
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase.auth.admin.listUsers({
        page,
        perPage
      });

      if (error) {
        throw error;
      }

      const users = data?.users || [];
      if (users.length === 0) {
        hasMore = false;
      } else {
        for (const user of users) {
          if (user.email && user.email.toLowerCase() === normalizedEmail) {
            matchingUsers.push(user);
          }
        }
        page += 1;
      }
    }

    if (matchingUsers.length === 0) {
      console.log("classification=AUTH_USER_NOT_FOUND");
      console.log("provisioned=0");
      process.exit(1);
    }

    if (matchingUsers.length > 1) {
      console.log("classification=MULTIPLE_AUTH_MATCHES");
      console.log("provisioned=0");
      process.exit(1);
    }

    const matchedUser = matchingUsers[0];

    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      "bootstrap_initial_admin",
      {
        p_auth_user_id: matchedUser.id,
        p_email: normalizedEmail,
        p_full_name: normalizedFullName
      }
    );

    if (rpcError) {
      const classification = mapDatabaseError(rpcError);
      console.log(`classification=${classification}`);
      console.log("provisioned=0");
      process.exit(1);
    }

    const classification = mapRpcResponse(rpcResult);
    console.log(`classification=${classification}`);

    if (
      classification === "CREATED" ||
      classification === "ALREADY_PROVISIONED" ||
      classification === "ROLE_REPAIRED"
    ) {
      console.log("provisioned=1");
      process.exit(0);
    } else {
      console.log("provisioned=0");
      process.exit(1);
    }
  } catch {
    console.log("classification=DATABASE_BOOTSTRAP_FAILURE");
    console.log("provisioned=0");
    process.exit(1);
  }
}

runBootstrap();
