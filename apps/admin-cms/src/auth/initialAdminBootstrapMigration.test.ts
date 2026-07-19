import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("Initial Admin Bootstrap Migration Static Contract Test", () => {
  it("should comply with every database safety rule in 0005_initial_admin_bootstrap.sql", () => {
    // Read migration 0005 file
    const migrationPath = path.resolve(
      process.cwd(),
      "../../infra/supabase/migrations/0005_initial_admin_bootstrap.sql"
    );

    expect(fs.existsSync(migrationPath)).toBe(true);
    const content = fs.readFileSync(migrationPath, "utf8");

    // Helper to normalize whitespaces
    const norm = content.replace(/\s+/g, " ");

    // 1. Transaction markers
    expect(norm).toContain("BEGIN;");
    expect(norm).toContain("COMMIT;");

    // 2. SECURITY DEFINER check
    expect(norm).toContain("SECURITY DEFINER");

    // 3. search_path check
    expect(norm).toContain("SET search_path = ''");

    // 4. Concurrency lock assertions
    expect(norm).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(norm).toContain("pg_catalog.hashtextextended");
    expect(norm).toContain("'capstone.bootstrap_initial_admin'");

    // Check lock appears before profile and role counts
    const lockIdx = norm.indexOf("pg_advisory_xact_lock");
    const countAdminsIdx = norm.indexOf("public.admin_users");
    const countRolesIdx = norm.indexOf("public.user_roles");

    expect(lockIdx).toBeGreaterThan(-1);
    expect(countAdminsIdx).toBeGreaterThan(lockIdx);
    expect(countRolesIdx).toBeGreaterThan(lockIdx);

    // 5. Schema qualification check
    // Ensure all tables are qualified with public or auth
    expect(norm).toContain("public.admin_users");
    expect(norm).toContain("public.user_roles");
    expect(norm).toContain("auth.users");

    // 6. Normalization inside sql
    expect(norm).toContain("pg_catalog.lower");
    expect(norm).toContain("pg_catalog.trim");
    expect(norm).toContain("v_trimmed_full_name := pg_catalog.trim(p_full_name);");
    
    // Assert that the email read from public.admin_users is normalized
    expect(norm).toContain("pg_catalog.lower(pg_catalog.trim(email))");

    // 7. No role parameter exists
    expect(norm).toContain("public.bootstrap_initial_admin( p_auth_user_id uuid, p_email text, p_full_name text )");
    expect(norm).not.toContain("p_role");

    // 8. Fixed role
    expect(norm).toContain("'admin'");

    // 9. Privilege grants and revokes
    expect(norm).toContain("REVOKE EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text, text) FROM PUBLIC;");
    expect(norm).toContain("REVOKE EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text, text) FROM anon;");
    expect(norm).toContain("REVOKE EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text, text) FROM authenticated;");
    expect(norm).toContain("GRANT EXECUTE ON FUNCTION public.bootstrap_initial_admin(uuid, text, text) TO service_role;");

    // 10. Forbidden commands
    expect(norm).not.toContain("DELETE FROM auth.users");
    expect(norm).not.toContain("UPDATE auth.users");
    expect(norm).not.toContain("INSERT INTO auth.users");
    expect(norm).not.toContain("DROP TABLE");
    expect(norm).not.toContain("TRUNCATE");
    expect(norm).not.toContain("PASSWORD");
    expect(norm).not.toContain("password");
    expect(norm).not.toContain("EXECUTE '");
  });
});
