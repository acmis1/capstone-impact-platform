import { describe, it, expect } from "vitest";
import {
  validateBootstrapInput,
  mapRpcResponse,
  mapDatabaseError,
  BootstrapInput
} from "./stagingAdminBootstrap";

describe("Staging Admin Bootstrap Input Validation", () => {
  it("should fail when confirmation is missing or incorrect", () => {
    const input1: BootstrapInput = {
      email: "admin@example.com",
      fullName: "Staging Admin",
      confirmation: undefined
    };
    expect(validateBootstrapInput(input1)).toEqual({
      isValid: false,
      error: "SAFE_PRECONDITION_FAILURE"
    });

    const input2: BootstrapInput = {
      email: "admin@example.com",
      fullName: "Staging Admin",
      confirmation: "WRONG_CONFIRMATION"
    };
    expect(validateBootstrapInput(input2)).toEqual({
      isValid: false,
      error: "SAFE_PRECONDITION_FAILURE"
    });
  });

  it("should fail when email is empty or invalid shape", () => {
    const input1: BootstrapInput = {
      email: "",
      fullName: "Staging Admin",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    };
    expect(validateBootstrapInput(input1)).toEqual({
      isValid: false,
      error: "SAFE_PRECONDITION_FAILURE"
    });

    const input2: BootstrapInput = {
      email: "not-an-email",
      fullName: "Staging Admin",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    };
    expect(validateBootstrapInput(input2)).toEqual({
      isValid: false,
      error: "SAFE_PRECONDITION_FAILURE"
    });
  });

  it("should fail when full name is empty", () => {
    const input: BootstrapInput = {
      email: "admin@example.com",
      fullName: "   ",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    };
    expect(validateBootstrapInput(input)).toEqual({
      isValid: false,
      error: "SAFE_PRECONDITION_FAILURE"
    });
  });

  it("should succeed with valid input and return normalized values", () => {
    const input: BootstrapInput = {
      email: "  ADMIN@Example.com  ",
      fullName: "  Staging Admin  ",
      confirmation: "LINK_EXISTING_STAGING_ADMIN"
    };
    expect(validateBootstrapInput(input)).toEqual({
      isValid: true,
      normalizedEmail: "admin@example.com",
      normalizedFullName: "Staging Admin"
    });
  });
});

describe("Staging Admin Bootstrap RPC Response Mapping", () => {
  it("should map exact success strings", () => {
    expect(mapRpcResponse("CREATED")).toBe("CREATED");
    expect(mapRpcResponse("ALREADY_PROVISIONED")).toBe("ALREADY_PROVISIONED");
    expect(mapRpcResponse("ROLE_REPAIRED")).toBe("ROLE_REPAIRED");
  });

  it("should map fallback for unexpected RPC response", () => {
    expect(mapRpcResponse("SOME_OTHER_RESPONSE")).toBe("DATABASE_BOOTSTRAP_FAILURE");
    expect(mapRpcResponse(null)).toBe("DATABASE_BOOTSTRAP_FAILURE");
    expect(mapRpcResponse(undefined)).toBe("DATABASE_BOOTSTRAP_FAILURE");
  });
});

describe("Staging Admin Bootstrap Error Mapping", () => {
  it("should map AUTH_USER_NOT_FOUND error", () => {
    const dbError = { code: "P0001", message: "exception: AUTH_USER_NOT_FOUND" };
    expect(mapDatabaseError(dbError)).toBe("AUTH_USER_NOT_FOUND");
  });

  it("should map AUTH_EMAIL_MISMATCH error", () => {
    const dbError = { code: "P0001", message: "exception: AUTH_EMAIL_MISMATCH" };
    expect(mapDatabaseError(dbError)).toBe("SAFE_PRECONDITION_FAILURE");
  });

  it("should map BOOTSTRAP_PRECONDITION_FAILED error", () => {
    const dbError = { code: "P0001", message: "exception: BOOTSTRAP_PRECONDITION_FAILED" };
    expect(mapDatabaseError(dbError)).toBe("SAFE_PRECONDITION_FAILURE");
  });

  it("should map general unexpected errors to DATABASE_BOOTSTRAP_FAILURE", () => {
    const dbError = { code: "57014", message: "canceling statement due to user request" };
    expect(mapDatabaseError(dbError)).toBe("DATABASE_BOOTSTRAP_FAILURE");
  });

  it("should verify that raw error details do not leak into mapped output", () => {
    const dbError = {
      code: "P0001",
      message: "exception: AUTH_EMAIL_MISMATCH",
      hint: "Secret credentials or UUID data leakage path",
      details: "Raw trace details"
    };
    const mapped = mapDatabaseError(dbError);
    expect(mapped).toBe("SAFE_PRECONDITION_FAILURE");
    expect(mapped).not.toContain("Secret");
    expect(mapped).not.toContain("UUID");
    expect(mapped).not.toContain("trace");
  });
});
