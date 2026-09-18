export interface DisposableRpcReadinessResponse {
  readonly data: unknown;
  readonly error: { readonly code?: string | null } | null;
}

export interface DisposableRpcReadinessProbe {
  readonly name: string;
  readonly invoke: (signal: AbortSignal) => Promise<DisposableRpcReadinessResponse>;
  readonly isExpected: (data: unknown) => boolean;
}

export interface DisposableRpcReadinessOptions {
  readonly maxAttempts?: number;
  readonly deadlineMs?: number;
  readonly requestTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 100;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function invokeWithTimeout(
  probe: DisposableRpcReadinessProbe,
  timeoutMs: number,
): Promise<DisposableRpcReadinessResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`DISPOSABLE_RPC_READINESS_REQUEST_TIMEOUT:${probe.name}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([probe.invoke(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readinessExhausted(probe: DisposableRpcReadinessProbe): Error {
  return new Error(`DISPOSABLE_RPC_READINESS_EXHAUSTED:${probe.name}`);
}

export async function waitForDisposableRpcReadiness(
  probes: readonly [DisposableRpcReadinessProbe, DisposableRpcReadinessProbe],
  options: DisposableRpcReadinessOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;

  if (
    !Number.isSafeInteger(maxAttempts) || maxAttempts < 1
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0
  ) throw new Error('DISPOSABLE_RPC_READINESS_OPTIONS_INVALID');

  const deadline = now() + deadlineMs;
  for (const probe of probes) {
    let attempts = 0;
    while (true) {
      const remainingMs = deadline - now();
      if (attempts >= maxAttempts || remainingMs <= 0) throw readinessExhausted(probe);
      attempts += 1;

      const response = await invokeWithTimeout(probe, Math.max(1, Math.min(requestTimeoutMs, remainingMs)));
      if (response.error !== null) {
        if (response.error?.code !== 'PGRST202') {
          throw new Error(`DISPOSABLE_RPC_READINESS_ERROR:${probe.name}`);
        }
        if (attempts >= maxAttempts || deadline - now() <= 0) throw readinessExhausted(probe);
        const delayMs = Math.min(retryDelayMs, Math.max(0, deadline - now()));
        if (delayMs > 0) await wait(delayMs);
        continue;
      }

      if (!probe.isExpected(response.data)) {
        throw new Error(`DISPOSABLE_RPC_READINESS_UNEXPECTED_RESULT:${probe.name}`);
      }
      break;
    }
  }
}
