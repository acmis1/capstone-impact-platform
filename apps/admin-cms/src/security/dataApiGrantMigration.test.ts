import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Database Migration 0004 Permission Contract Test", () => {
  const migrationPath = path.resolve(
    __dirname,
    "../../../../infra/supabase/migrations/0004_explicit_data_api_grants.sql"
  );

  // Helper to normalize SQL content (collapses whitespace, removes comments, converts to uppercase)
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

  it("1. The migration file exists", () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it("2. It contains BEGIN and COMMIT", () => {
    const sql = getNormalizedSql(migrationPath);
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.endsWith("COMMIT;")).toBe(true);
  });

  it("3. It contains default-privilege revokes for table CRUD, sequence usage/select, and function execute", () => {
    const sql = getNormalizedSql(migrationPath);

    // Revokes on tables
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE POSTGRES IN SCHEMA PUBLIC REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ANON, AUTHENTICATED, SERVICE_ROLE"
    );

    // Revokes on sequences
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE POSTGRES IN SCHEMA PUBLIC REVOKE USAGE, SELECT ON SEQUENCES FROM ANON, AUTHENTICATED, SERVICE_ROLE"
    );

    // Revokes on functions
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE POSTGRES IN SCHEMA PUBLIC REVOKE EXECUTE ON FUNCTIONS FROM ANON, AUTHENTICATED, SERVICE_ROLE"
    );
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE POSTGRES IN SCHEMA PUBLIC REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
    );
  });

  it("4. It explicitly grants schema usage only to authenticated and service_role", () => {
    const sql = getNormalizedSql(migrationPath);
    // Find all schema usage grants
    const grantUsageMatches = [...sql.matchAll(/GRANT USAGE ON SCHEMA (\w+) TO ([^;]+)/g)];
    expect(grantUsageMatches.length).toBeGreaterThan(0);

    for (const match of grantUsageMatches) {
      const roles = match[2].split(",").map(r => r.trim());
      for (const role of roles) {
        expect(["AUTHENTICATED", "SERVICE_ROLE"]).toContain(role);
        expect(role).not.toBe("ANON");
        expect(role).not.toBe("PUBLIC");
      }
    }
  });

  it("5 & 6. Every one of the 13 tables appears in the service_role CRUD grant with exact operations", () => {
    const sql = getNormalizedSql(migrationPath);

    // Find service_role CRUD grants
    // We expect: GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ... TO SERVICE_ROLE
    const crudGrantPattern = /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ([\s\S]+?) TO SERVICE_ROLE/;
    const match = sql.match(crudGrantPattern);
    expect(match).not.toBeNull();

    const tablesList = match![1].split(",").map(t => t.trim().replace(/^PUBLIC\./, ""));
    const expectedTables = [
      "PROGRAMS",
      "DISCIPLINES",
      "INDUSTRY_CATEGORIES",
      "ADMIN_USERS",
      "USER_ROLES",
      "IMPORT_BATCHES",
      "PROJECTS",
      "PROJECT_DISCIPLINES",
      "PROJECT_INDUSTRY_CATEGORIES",
      "MEDIA_ASSETS",
      "VALIDATION_FLAGS",
      "APPROVAL_RECORDS",
      "PUBLISHED_SNAPSHOTS"
    ];

    expect(tablesList.length).toBe(expectedTables.length);
    for (const table of expectedTables) {
      expect(tablesList).toContain(table);
    }

    // Ensure there are no other grants to service_role with broader/narrower words in that block
    expect(match![0]).toContain("SELECT, INSERT, UPDATE, DELETE");
  });

  it("7 & 9. authenticated receives SELECT on exactly programs, disciplines, industry_categories", () => {
    const sql = getNormalizedSql(migrationPath);

    const authSelectPattern = /GRANT SELECT ON TABLE ([\s\S]+?) TO AUTHENTICATED/;
    const match = sql.match(authSelectPattern);
    expect(match).not.toBeNull();

    const tablesList = match![1].split(",").map(t => t.trim().replace(/^PUBLIC\./, ""));
    const expectedLookupTables = [
      "PROGRAMS",
      "DISCIPLINES",
      "INDUSTRY_CATEGORIES"
    ];

    expect(tablesList.length).toBe(expectedLookupTables.length);
    for (const table of expectedLookupTables) {
      expect(tablesList).toContain(table);
    }

    // Ensure authenticated receives no grant on internal tables
    const sensitiveTables = [
      "ADMIN_USERS",
      "USER_ROLES",
      "IMPORT_BATCHES",
      "PROJECTS",
      "PROJECT_DISCIPLINES",
      "PROJECT_INDUSTRY_CATEGORIES",
      "MEDIA_ASSETS",
      "VALIDATION_FLAGS",
      "APPROVAL_RECORDS",
      "PUBLISHED_SNAPSHOTS"
    ];

    for (const table of sensitiveTables) {
      expect(tablesList).not.toContain(table);
    }
  });

  it("8. No GRANT statement targets anon", () => {
    const sql = getNormalizedSql(migrationPath);
    // Ensure "TO ANON" or "TO ... ANON" does not exist in any GRANT statement
    // We search for GRANT keywords followed by TO containing ANON
    const grantMatches = [...sql.matchAll(/GRANT [\s\S]+? TO ([\s\S]+?)(?=;)/g)];
    for (const match of grantMatches) {
      const rolesStr = match[1];
      const roles = rolesStr.split(",").map(r => r.trim());
      expect(roles).not.toContain("ANON");
    }
  });

  it("10. The trigger function execute privilege is revoked", () => {
    const sql = getNormalizedSql(migrationPath);
    expect(sql).toContain(
      "REVOKE EXECUTE ON FUNCTION PUBLIC.UPDATE_UPDATED_AT_COLUMN() FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE"
    );
  });

  it("11. The migration contains no destructive, manipulative, or forbidden actions", () => {
    const sql = getNormalizedSql(migrationPath);

    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain("TRUNCATE");
    expect(sql).not.toContain("INSERT INTO");
    expect(sql).not.toContain("UPDATE TABLE"); // note: UPDATE as privilege is allowed (e.g., GRANT UPDATE), but "UPDATE table" as query statement is not
    expect(sql).not.toContain("DELETE FROM");
    expect(sql).not.toContain("ALTER ROLE");
    expect(sql).not.toContain("SECURITY DEFINER");

    // Schema mutations
    expect(sql).not.toMatch(/ALTER SCHEMA \w+ CREATE/);
    expect(sql).not.toContain("AUTH.");
    expect(sql).not.toContain("STORAGE.");
  });

  it("12. No blanket GRANT ALL appears", () => {
    const sql = getNormalizedSql(migrationPath);
    expect(sql).not.toContain("GRANT ALL");
  });
});
