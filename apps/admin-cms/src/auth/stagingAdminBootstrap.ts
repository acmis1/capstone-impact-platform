export type BootstrapResult =
  | "CREATED"
  | "ALREADY_PROVISIONED"
  | "ROLE_REPAIRED"
  | "SAFE_PRECONDITION_FAILURE"
  | "AUTH_USER_NOT_FOUND"
  | "MULTIPLE_AUTH_MATCHES"
  | "DATABASE_FUNCTION_UNDEFINED"
  | "DATABASE_FUNCTION_NOT_FOUND"
  | "DATABASE_FUNCTION_AMBIGUOUS"
  | "DATABASE_PERMISSION_FAILURE"
  | "DATABASE_CONSTRAINT_FAILURE"
  | "DATABASE_BOOTSTRAP_FAILURE";

export interface BootstrapInput {
  email: string | undefined;
  fullName: string | undefined;
  confirmation: string | undefined;
}

export function validateBootstrapInput(input: BootstrapInput): {
  isValid: boolean;
  error?: BootstrapResult;
  normalizedEmail?: string;
  normalizedFullName?: string;
} {
  const { email, fullName, confirmation } = input;

  if (confirmation !== "LINK_EXISTING_STAGING_ADMIN") {
    return { isValid: false, error: "SAFE_PRECONDITION_FAILURE" };
  }

  if (!email || !email.trim()) {
    return { isValid: false, error: "SAFE_PRECONDITION_FAILURE" };
  }

  const normalizedEmail = email.trim().toLowerCase();
  
  // Basic email shape verification
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return { isValid: false, error: "SAFE_PRECONDITION_FAILURE" };
  }

  if (!fullName || !fullName.trim()) {
    return { isValid: false, error: "SAFE_PRECONDITION_FAILURE" };
  }

  return {
    isValid: true,
    normalizedEmail,
    normalizedFullName: fullName.trim()
  };
}

export function mapRpcResponse(response: string | null | undefined): BootstrapResult {
  if (response === "CREATED") return "CREATED";
  if (response === "ALREADY_PROVISIONED") return "ALREADY_PROVISIONED";
  if (response === "ROLE_REPAIRED") return "ROLE_REPAIRED";
  return "DATABASE_BOOTSTRAP_FAILURE";
}

export function mapDatabaseError(error: unknown): BootstrapResult {
  const err = error as Record<string, unknown> | null | undefined;
  const message = String(err?.message ?? "");
  const code = String(err?.code ?? "");

  if (message.includes("AUTH_USER_NOT_FOUND")) {
    return "AUTH_USER_NOT_FOUND";
  }
  if (message.includes("AUTH_EMAIL_MISMATCH")) {
    return "SAFE_PRECONDITION_FAILURE";
  }
  if (message.includes("BOOTSTRAP_PRECONDITION_FAILED")) {
    return "SAFE_PRECONDITION_FAILURE";
  }

  if (code === "42883" || (message.includes("function") && message.includes("does not exist"))) {
    return "DATABASE_FUNCTION_UNDEFINED";
  }
  if (code === "PGRST202") {
    return "DATABASE_FUNCTION_NOT_FOUND";
  }
  if (code === "PGRST203") {
    return "DATABASE_FUNCTION_AMBIGUOUS";
  }
  if (code === "42501" || message.includes("permission denied") || message.includes("insufficient privilege")) {
    return "DATABASE_PERMISSION_FAILURE";
  }
  if (code.startsWith("23") || message.includes("constraint") || message.includes("violates")) {
    return "DATABASE_CONSTRAINT_FAILURE";
  }

  return "DATABASE_BOOTSTRAP_FAILURE";
}
