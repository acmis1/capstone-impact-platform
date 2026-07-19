export type BootstrapResult =
  | "CREATED"
  | "ALREADY_PROVISIONED"
  | "ROLE_REPAIRED"
  | "SAFE_PRECONDITION_FAILURE"
  | "AUTH_USER_NOT_FOUND"
  | "MULTIPLE_AUTH_MATCHES"
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

  if (message.includes("AUTH_USER_NOT_FOUND")) {
    return "AUTH_USER_NOT_FOUND";
  }
  if (message.includes("AUTH_EMAIL_MISMATCH")) {
    return "SAFE_PRECONDITION_FAILURE";
  }
  if (message.includes("BOOTSTRAP_PRECONDITION_FAILED")) {
    return "SAFE_PRECONDITION_FAILURE";
  }

  return "DATABASE_BOOTSTRAP_FAILURE";
}
