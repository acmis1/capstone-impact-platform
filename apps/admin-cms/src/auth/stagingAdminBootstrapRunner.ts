import { User } from "@supabase/supabase-js";
import { validateBootstrapInput, mapRpcResponse, mapDatabaseError, BootstrapResult } from "./stagingAdminBootstrap";

export interface StagingAdminBootstrapRunnerResult {
  classification: BootstrapResult;
  provisioned: 0 | 1;
  authMatchCount: number;
  pagesRead: number;
  rpcCalled: "YES" | "NO";
}

export interface InjectedSupabaseClient {
  auth: {
    admin: {
      listUsers(params: { page: number; perPage: number }): Promise<{
        data: { users: User[] } | null;
        error: unknown;
      }>;
    };
  };
  rpc(
    fn: string,
    params: Record<string, unknown>
  ): Promise<{
    data: unknown;
    error: unknown;
  }>;
}

export async function executeStagingAdminBootstrap(params: {
  client: InjectedSupabaseClient;
  email: string | undefined;
  fullName: string | undefined;
  confirmation: string | undefined;
}): Promise<StagingAdminBootstrapRunnerResult> {
  const { client, email, fullName, confirmation } = params;

  const validation = validateBootstrapInput({ email, fullName, confirmation });
  if (!validation.isValid) {
    return {
      classification: validation.error || "SAFE_PRECONDITION_FAILURE",
      provisioned: 0,
      authMatchCount: 0,
      pagesRead: 0,
      rpcCalled: "NO"
    };
  }

  const { normalizedEmail, normalizedFullName } = validation;

  let page = 1;
  const perPage = 100;
  const matchingUsers: User[] = [];
  let hasMore = true;
  let pagesRead = 0;

  try {
    while (hasMore) {
      const response = await client.auth.admin.listUsers({
        page,
        perPage
      });
      pagesRead += 1;

      if (response.error) {
        return {
          classification: "DATABASE_BOOTSTRAP_FAILURE",
          provisioned: 0,
          authMatchCount: 0,
          pagesRead,
          rpcCalled: "NO"
        };
      }

      const users = response.data?.users || [];
      if (users.length === 0) {
        hasMore = false;
      } else {
        for (const user of users) {
          if (user.email && user.email.trim().toLowerCase() === normalizedEmail) {
            matchingUsers.push(user);
          }
        }
        page += 1;
      }
    }
  } catch {
    return {
      classification: "DATABASE_BOOTSTRAP_FAILURE",
      provisioned: 0,
      authMatchCount: 0,
      pagesRead,
      rpcCalled: "NO"
    };
  }

  const authMatchCount = matchingUsers.length;

  if (authMatchCount === 0) {
    return {
      classification: "AUTH_USER_NOT_FOUND",
      provisioned: 0,
      authMatchCount,
      pagesRead,
      rpcCalled: "NO"
    };
  }

  if (authMatchCount > 1) {
    return {
      classification: "MULTIPLE_AUTH_MATCHES",
      provisioned: 0,
      authMatchCount,
      pagesRead,
      rpcCalled: "NO"
    };
  }

  const matchedUser = matchingUsers[0];

  try {
    const { data: rpcResult, error: rpcError } = await client.rpc(
      "bootstrap_initial_admin",
      {
        p_auth_user_id: matchedUser.id,
        p_email: normalizedEmail,
        p_full_name: normalizedFullName
      }
    );

    if (rpcError) {
      const classification = mapDatabaseError(rpcError);
      return {
        classification,
        provisioned: 0,
        authMatchCount,
        pagesRead,
        rpcCalled: "YES"
      };
    }

    const classification = mapRpcResponse(rpcResult as string | null | undefined);
    const provisioned = (classification === "CREATED" || classification === "ALREADY_PROVISIONED" || classification === "ROLE_REPAIRED") ? 1 : 0;

    return {
      classification,
      provisioned,
      authMatchCount,
      pagesRead,
      rpcCalled: "YES"
    };
  } catch {
    return {
      classification: "DATABASE_BOOTSTRAP_FAILURE",
      provisioned: 0,
      authMatchCount,
      pagesRead,
      rpcCalled: "YES"
    };
  }
}
