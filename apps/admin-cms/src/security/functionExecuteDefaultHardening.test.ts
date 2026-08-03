import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Database Migration 0007 Default Function Execution Hardening Test", () => {
  const migrationsDir = path.resolve(
    __dirname,
    "../../../../infra/supabase/migrations"
  );
  const targetMigrationFilename =
    "20260803174000_harden_function_execute_defaults.sql";
  const targetMigrationPath = path.join(
    migrationsDir,
    targetMigrationFilename
  );

  const getNormalizedSql = (filePath: string): string => {
    const rawContent = fs.readFileSync(filePath, "utf-8");
    // Remove block comments /* ... */
    let cleanContent = rawContent.replace(/\/\*[\s\S]*?\*\//g, "");
    // Remove single line comments
    cleanContent = cleanContent
      .split("\n")
      .map((line) => {
        const commentIndex = line.indexOf("--");
        return commentIndex !== -1 ? line.substring(0, commentIndex) : line;
      })
      .join(" ");

    return cleanContent.replace(/\s+/g, " ").trim().toUpperCase();
  };

  it("1. The new migration exists and is later than all prior migrations", () => {
    expect(fs.existsSync(targetMigrationPath)).toBe(true);

    const allMigrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const targetIndex = allMigrationFiles.indexOf(targetMigrationFilename);
    expect(targetIndex).toBeGreaterThan(0);
    expect(targetIndex).toBe(allMigrationFiles.length - 1);
  });

  it("2. It contains an explicit BEGIN and COMMIT transaction", () => {
    const sql = getNormalizedSql(targetMigrationPath);
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.endsWith("COMMIT;")).toBe(true);
  });

  it("3 & 4. It contains a GLOBAL ALTER DEFAULT PRIVILEGES FOR ROLE postgres revoking EXECUTE on functions from all Data API roles with no IN SCHEMA clause", () => {
    const sql = getNormalizedSql(targetMigrationPath);

    // Global alter default privileges pattern (must NOT contain IN SCHEMA)
    const globalAlterMatch = sql.match(
      /ALTER DEFAULT PRIVILEGES FOR ROLE POSTGRES\s+REVOKE EXECUTE ON FUNCTIONS FROM ([^;]+)/
    );
    expect(globalAlterMatch).not.toBeNull();

    const rolesStr = globalAlterMatch![1];
    const roles = rolesStr.split(",").map((r) => r.trim());

    expect(roles.length).toBe(4);
    expect(roles).toContain("PUBLIC");
    expect(roles).toContain("ANON");
    expect(roles).toContain("AUTHENTICATED");
    expect(roles).toContain("SERVICE_ROLE");

    // Ensure no IN SCHEMA clause was included in this global statement
    expect(globalAlterMatch![0]).not.toContain("IN SCHEMA");
  });

  it("5 & 6. The public.rls_auto_enable() revoke is protected by a PL/pgSQL existence check for the exact 0-argument function in schema public", () => {
    const sql = getNormalizedSql(targetMigrationPath);

    // Verify DO block and existence check predicates
    expect(sql).toContain("DO $$");
    expect(sql).toContain("IF EXISTS");
    expect(sql).toContain("NSPNAME = 'PUBLIC'");
    expect(sql).toContain("PRONAME = 'RLS_AUTO_ENABLE'");
    expect(sql).toContain("PRONARGS = 0");
    expect(sql).toContain("PROKIND = 'F'");
    expect(sql).toContain("PRORETTYPE = 'EVENT_TRIGGER'::REGTYPE");

    // Verify guarded revoke targets public.rls_auto_enable() and all Data API roles
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION PUBLIC.RLS_AUTO_ENABLE()");
    expect(sql).toContain("FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE");
  });

  it("7. The migration contains no modification of supabase_admin defaults", () => {
    const rawContent = fs.readFileSync(targetMigrationPath, "utf-8");
    expect(rawContent.toUpperCase()).not.toContain("SUPABASE_ADMIN");
  });

  it("8. The migration contains no forbidden, state-changing, or schema-mutating statements", () => {
    const sql = getNormalizedSql(targetMigrationPath);

    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION");
    expect(sql).not.toContain("DROP EVENT TRIGGER");
    expect(sql).not.toContain("ALTER EVENT TRIGGER");
    expect(sql).not.toMatch(/ALTER FUNCTION[\s\S]+?OWNER/);
    expect(sql).not.toContain("GRANT EXECUTE");
    expect(sql).not.toContain("ALTER ROLE");

    // DML, DDL table, schema, and policy statements
    expect(sql).not.toContain("CREATE TABLE");
    expect(sql).not.toContain("ALTER TABLE");
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain("UPDATE");
    expect(sql).not.toContain("MERGE");
    expect(sql).not.toContain("CREATE SCHEMA");
    expect(sql).not.toContain("DROP SCHEMA");
    expect(sql).not.toContain("CREATE POLICY");
    expect(sql).not.toContain("ALTER POLICY");
    expect(sql).not.toContain("DROP POLICY");
    expect(sql).not.toContain("INSERT INTO");
    expect(sql).not.toContain("DELETE FROM");
    expect(sql).not.toContain("TRUNCATE");

    // Auth & storage schemas
    expect(sql).not.toContain("AUTH.");
    expect(sql).not.toContain("STORAGE.");
  });

  it("9. Existing migration contracts remain intact in migrations 0004 and 0006", () => {
    const migration0004Path = path.join(
      migrationsDir,
      "20260719003407_explicit_data_api_grants.sql"
    );
    const migration0006Path = path.join(
      migrationsDir,
      "20260719165119_fix_initial_admin_bootstrap_runtime.sql"
    );

    const sql0004 = getNormalizedSql(migration0004Path);
    const sql0006 = getNormalizedSql(migration0006Path);

    // update_updated_at_column execution remains revoked from all 4 roles
    expect(sql0004).toContain(
      "REVOKE EXECUTE ON FUNCTION PUBLIC.UPDATE_UPDATED_AT_COLUMN() FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE"
    );

    // bootstrap_initial_admin execution remains revoked from PUBLIC, anon, authenticated and granted to service_role
    expect(sql0006).toContain(
      "REVOKE EXECUTE ON FUNCTION PUBLIC.BOOTSTRAP_INITIAL_ADMIN(UUID, TEXT, TEXT) FROM PUBLIC"
    );
    expect(sql0006).toContain(
      "REVOKE EXECUTE ON FUNCTION PUBLIC.BOOTSTRAP_INITIAL_ADMIN(UUID, TEXT, TEXT) FROM ANON"
    );
    expect(sql0006).toContain(
      "REVOKE EXECUTE ON FUNCTION PUBLIC.BOOTSTRAP_INITIAL_ADMIN(UUID, TEXT, TEXT) FROM AUTHENTICATED"
    );
    expect(sql0006).toContain(
      "GRANT EXECUTE ON FUNCTION PUBLIC.BOOTSTRAP_INITIAL_ADMIN(UUID, TEXT, TEXT) TO SERVICE_ROLE"
    );
  });
});
