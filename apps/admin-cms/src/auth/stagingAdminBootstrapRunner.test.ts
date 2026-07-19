import { describe, it, expect, vi } from "vitest";
import { executeStagingAdminBootstrap, InjectedSupabaseClient } from "./stagingAdminBootstrapRunner";

describe("Staging Admin Bootstrap Runner", () => {
  it("should fail validation and not call client when confirmation is missing", async () => {
    const mockListUsers = vi.fn();
    const mockRpc = vi.fn();
    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "Admin User",
      confirmation: undefined
    });

    expect(result.classification).toBe("SAFE_PRECONDITION_FAILURE");
    expect(result.rpcCalled).toBe("NO");
    expect(mockListUsers).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("should fail validation when email is invalid shape", async () => {
    const mockListUsers = vi.fn();
    const client = {
      auth: { admin: { listUsers: mockListUsers } }
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "invalid-email",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("SAFE_PRECONDITION_FAILURE");
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it("should fail validation when full name is empty", async () => {
    const mockListUsers = vi.fn();
    const client = {
      auth: { admin: { listUsers: mockListUsers } }
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "   ",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("SAFE_PRECONDITION_FAILURE");
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it("should return AUTH_USER_NOT_FOUND when zero Auth matches are found", async () => {
    const mockListUsers = vi.fn().mockResolvedValue({
      data: { users: [] },
      error: null
    });
    const mockRpc = vi.fn();
    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("AUTH_USER_NOT_FOUND");
    expect(result.rpcCalled).toBe("NO");
    expect(mockListUsers).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("should succeed and call RPC once when exactly one Auth match is found (trim and case-insensitive verified)", async () => {
    const mockListUsers = vi.fn().mockResolvedValue({
      data: {
        users: [
          { id: "uuid-1234", email: "  Admin@EXAMPLE.com  " }
        ]
      },
      error: null
    });
    const mockRpc = vi.fn().mockResolvedValue({
      data: "CREATED",
      error: null
    });
    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "  ADMIN@Example.com  ",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("CREATED");
    expect(result.rpcCalled).toBe("YES");
    expect(result.provisioned).toBe(1);
    expect(result.authMatchCount).toBe(1);
    expect(mockRpc).toHaveBeenCalledWith("bootstrap_initial_admin", {
      p_auth_user_id: "uuid-1234",
      p_email: "admin@example.com",
      p_full_name: "Admin User"
    });

    // Verify safe result contains no UUID or email
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("uuid-1234");
    expect(serialized).not.toContain("admin@example.com");
  });

  it("should return MULTIPLE_AUTH_MATCHES and NOT call RPC when multiple matches are found", async () => {
    const mockListUsers = vi.fn().mockResolvedValue({
      data: {
        users: [
          { id: "uuid-1234", email: "admin@example.com" },
          { id: "uuid-5678", email: "admin@example.com" }
        ]
      },
      error: null
    });
    const mockRpc = vi.fn();
    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("MULTIPLE_AUTH_MATCHES");
    expect(result.rpcCalled).toBe("NO");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("should support pagination and find matching user on later pages", async () => {
    const mockListUsers = vi.fn()
      .mockResolvedValueOnce({
        data: {
          users: [
            { id: "uuid-other", email: "other@example.com" }
          ]
        },
        error: null
      })
      .mockResolvedValueOnce({
        data: {
          users: [
            { id: "uuid-1234", email: "admin@example.com" }
          ]
        },
        error: null
      })
      .mockResolvedValueOnce({
        data: { users: [] },
        error: null
      });

    const mockRpc = vi.fn().mockResolvedValue({
      data: "ALREADY_PROVISIONED",
      error: null
    });

    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("ALREADY_PROVISIONED");
    expect(result.rpcCalled).toBe("YES");
    expect(result.pagesRead).toBe(3);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("should return DATABASE_BOOTSTRAP_FAILURE when listUsers fails", async () => {
    const mockListUsers = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Internal server error connecting auth service" }
    });
    const mockRpc = vi.fn();
    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("DATABASE_BOOTSTRAP_FAILURE");
    expect(result.rpcCalled).toBe("NO");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("should return ROLE_REPAIRED on successful RPC recovery response", async () => {
    const mockListUsers = vi.fn().mockResolvedValue({
      data: {
        users: [{ id: "uuid-1234", email: "admin@example.com" }]
      },
      error: null
    });
    const mockRpc = vi.fn().mockResolvedValue({
      data: "ROLE_REPAIRED",
      error: null
    });
    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("ROLE_REPAIRED");
    expect(result.provisioned).toBe(1);
  });

  it("should handle controlled RPC database failures safely", async () => {
    const mockListUsers = vi.fn().mockResolvedValue({
      data: {
        users: [{ id: "uuid-1234", email: "admin@example.com" }]
      },
      error: null
    });
    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "exception: AUTH_EMAIL_MISMATCH" }
    });
    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("SAFE_PRECONDITION_FAILURE");
    expect(result.provisioned).toBe(0);
  });

  it("should handle unexpected RPC failures safely without leaking raw error text", async () => {
    const mockListUsers = vi.fn().mockResolvedValue({
      data: {
        users: [{ id: "uuid-1234", email: "admin@example.com" }]
      },
      error: null
    });
    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "57014", message: "Query timeout expired raw exception trace trace_id=884" }
    });
    const client = {
      auth: { admin: { listUsers: mockListUsers } },
      rpc: mockRpc
    } as unknown as InjectedSupabaseClient;

    const result = await executeStagingAdminBootstrap({
      client,
      email: "admin@example.com",
      fullName: "Admin User",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    });

    expect(result.classification).toBe("DATABASE_BOOTSTRAP_FAILURE");
    expect(JSON.stringify(result)).not.toContain("trace");
    expect(JSON.stringify(result)).not.toContain("timeout");
  });
});
