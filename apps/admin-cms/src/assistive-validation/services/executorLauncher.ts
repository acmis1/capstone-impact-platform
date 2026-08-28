import type { LaunchOutcome } from '../domain/executionControlContract';

/**
 * Cloud execution adapter boundary.
 *
 * The assistive domain knows about a launcher; it knows nothing about any specific provider. A
 * future move to a Kubernetes Job, a systemd unit, or another serverless job runner replaces only
 * the implementation below and touches no queue, finding, publication, or schema behaviour.
 */

/**
 * Opaque, provider-specific payload produced by a preflight that has transmitted nothing.
 *
 * It carries the credential obtained during preparation so that the irreversible step needs no
 * further failure-prone work between the reservation and the request going out.
 */
export type PreparedExecution = {
  readonly requestBody: unknown;
  readonly containerName: string;
  readonly credential: string;
};

export type PrepareResult =
  | { ok: true; prepared: PreparedExecution }
  | { ok: false; reason: string };

export type StartResult = {
  /** Never `PRESTART_FAILED`: reaching this point means a request was transmitted. */
  outcome: Exclude<LaunchOutcome, 'PRESTART_FAILED'>;
  executionReference: string | null;
  detail: string;
};

export interface ExecutorLauncher {
  /**
   * Non-side-effecting preparation. Everything that can fail without transmitting a start request
   * happens here, so a failure is safely refundable.
   */
  prepare(): Promise<PrepareResult>;
  /**
   * Transmits the start request. Once called, the reserved unit is permanently consumed whatever
   * this returns.
   */
  start(prepared: PreparedExecution, reservationToken: string, generation: number): Promise<StartResult>;
}

export interface AzureContainerAppsJobLauncherConfig {
  readonly identityEndpoint: string;
  readonly identityHeader: string;
  readonly managedIdentityClientId: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly jobName: string;
  readonly expectedDeploymentVersion: string;
  readonly expectedImageDigest: string;
  readonly requestTimeoutMs?: number;
}

const ARM_SCOPE = 'https://management.azure.com';
const ARM_API_VERSION = '2026-01-01';
const IDENTITY_API_VERSION = '2019-08-01';
const RESERVATION_TOKEN_VARIABLE = 'CAPSTONE_ASSISTIVE_RESERVATION_TOKEN';
const RESERVATION_GENERATION_VARIABLE = 'CAPSTONE_ASSISTIVE_RESERVATION_GENERATION';

type EnvironmentVar = { name?: string; value?: string; secretRef?: string };
type TemplateContainer = {
  name?: string;
  image?: string;
  command?: string[];
  args?: string[];
  env?: EnvironmentVar[];
  resources?: { cpu?: unknown; memory?: unknown };
};

const EXPECTED_WORKER_COMMAND = [
  'npm', 'run', 'run:assistive-worker:on-demand', '--workspace=apps/admin-cms',
] as const;

function hasValue(container: TemplateContainer, name: string, expected: string): boolean {
  const matches = (container.env ?? []).filter((entry) => entry.name === name);
  return matches.length === 1
    && matches[0].value === expected
    && matches[0].secretRef === undefined;
}

function hasSecretReference(container: TemplateContainer, name: string): boolean {
  const matches = (container.env ?? []).filter((entry) => entry.name === name);
  return matches.length === 1
    && typeof matches[0].secretRef === 'string'
    && matches[0].secretRef.length > 0
    && matches[0].value === undefined;
}

function isCompleteWorkerTemplate(container: TemplateContainer): boolean {
  return JSON.stringify(container.command) === JSON.stringify(EXPECTED_WORKER_COMMAND)
    && container.resources?.cpu === 2
    && (container.resources.memory === '4Gi' || container.resources.memory === '4.0Gi')
    && hasValue(container, 'CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED', 'true')
    && hasValue(container, 'CAPSTONE_ASSISTIVE_EXECUTION_MODE', 'ON_DEMAND')
    && hasValue(container, 'CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID', container.name ?? '')
    && hasSecretReference(container, 'SUPABASE_SECRET_KEY');
}

/**
 * Copies exactly the fields the job execution template accepts, so an override preserves the
 * deployed container definition instead of reconstructing a partial one from memory.
 */
function toExecutionContainer(container: TemplateContainer): TemplateContainer {
  const projected: TemplateContainer = { name: container.name, image: container.image };
  if (container.command !== undefined) projected.command = container.command;
  if (container.args !== undefined) projected.args = container.args;
  if (container.env !== undefined) projected.env = container.env;
  if (container.resources !== undefined) projected.resources = container.resources;
  return projected;
}

function withReservationEnvironment(
  container: TemplateContainer,
  reservationToken: string,
  generation: number,
): TemplateContainer {
  const preserved = (container.env ?? []).filter((entry) =>
    entry.name !== RESERVATION_TOKEN_VARIABLE && entry.name !== RESERVATION_GENERATION_VARIABLE);
  return {
    ...container,
    env: [
      ...preserved,
      { name: RESERVATION_TOKEN_VARIABLE, value: reservationToken },
      { name: RESERVATION_GENERATION_VARIABLE, value: String(generation) },
    ],
  };
}

export class AzureContainerAppsJobLauncher implements ExecutorLauncher {
  constructor(
    private readonly config: AzureContainerAppsJobLauncherConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get jobResourcePath(): string {
    return `/subscriptions/${this.config.subscriptionId}`
      + `/resourceGroups/${this.config.resourceGroup}`
      + `/providers/Microsoft.App/jobs/${this.config.jobName}`;
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.config.requestTimeoutMs ?? 4_000);
  }

  private async accessToken(): Promise<string | null> {
    const url = new URL(this.config.identityEndpoint);
    url.searchParams.set('resource', ARM_SCOPE);
    url.searchParams.set('api-version', IDENTITY_API_VERSION);
    url.searchParams.set('client_id', this.config.managedIdentityClientId);
    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: { 'X-IDENTITY-HEADER': this.config.identityHeader },
        signal: this.signal(),
      });
      if (!response.ok) return null;
      const body = await response.json() as { access_token?: unknown };
      return typeof body.access_token === 'string' && body.access_token.length > 0
        ? body.access_token
        : null;
    } catch {
      return null;
    }
  }

  async prepare(): Promise<PrepareResult> {
    const token = await this.accessToken();
    if (!token) return { ok: false, reason: 'IDENTITY_TOKEN_UNAVAILABLE' };

    let job: { properties?: { template?: { containers?: unknown; initContainers?: unknown } } };
    try {
      const response = await this.fetchImpl(
        `${ARM_SCOPE}${this.jobResourcePath}?api-version=${ARM_API_VERSION}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: this.signal() },
      );
      if (!response.ok) return { ok: false, reason: `JOB_READ_FAILED_${response.status}` };
      job = await response.json() as typeof job;
    } catch {
      return { ok: false, reason: 'JOB_READ_FAILED' };
    }

    const containers = job.properties?.template?.containers;
    if (!Array.isArray(containers) || containers.length !== 1) {
      return { ok: false, reason: 'JOB_TEMPLATE_INVALID' };
    }
    const matching = (containers as TemplateContainer[]).filter((container) =>
      typeof container.image === 'string'
      && container.image.endsWith(`@${this.config.expectedImageDigest}`));
    if (matching.length !== 1 || typeof matching[0].name !== 'string' || !matching[0].name) {
      return { ok: false, reason: 'JOB_IMAGE_DIGEST_MISMATCH' };
    }
    if (!hasValue(matching[0], 'CAPSTONE_DEPLOYMENT_VERSION', this.config.expectedDeploymentVersion)) {
      return { ok: false, reason: 'JOB_DEPLOYMENT_MISMATCH' };
    }
    if (!hasValue(matching[0], 'CAPSTONE_ASSISTIVE_IMAGE_DIGEST', this.config.expectedImageDigest)
        || !isCompleteWorkerTemplate(matching[0])) {
      return { ok: false, reason: 'JOB_TEMPLATE_INVALID' };
    }

    const initContainers = job.properties?.template?.initContainers;
    return {
      ok: true,
      prepared: {
        containerName: matching[0].name,
        credential: token,
        requestBody: {
          containers: (containers as TemplateContainer[]).map(toExecutionContainer),
          ...(Array.isArray(initContainers)
            ? { initContainers: (initContainers as TemplateContainer[]).map(toExecutionContainer) }
            : {}),
        },
      },
    };
  }

  async start(
    prepared: PreparedExecution,
    reservationToken: string,
    generation: number,
  ): Promise<StartResult> {
    const body = prepared.requestBody as { containers: TemplateContainer[]; initContainers?: TemplateContainer[] };
    const payload = {
      ...body,
      containers: body.containers.map((container) => container.name === prepared.containerName
        ? withReservationEnvironment(container, reservationToken, generation)
        : container),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${ARM_SCOPE}${this.jobResourcePath}/start?api-version=${ARM_API_VERSION}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${prepared.credential}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: this.signal(),
        },
      );
    } catch {
      return { outcome: 'START_AMBIGUOUS', executionReference: null, detail: 'TRANSPORT_FAILURE' };
    }

    if (response.status === 202) {
      return { outcome: 'START_ACCEPTED', executionReference: null, detail: 'ACCEPTED_202' };
    }
    if (!response.ok) {
      return {
        outcome: 'START_RESPONSE_ERROR',
        executionReference: null,
        detail: `HTTP_${response.status}`,
      };
    }
    try {
      const created = await response.json() as { name?: unknown };
      return {
        outcome: 'START_ACCEPTED',
        executionReference: typeof created.name === 'string' ? created.name : null,
        detail: 'ACCEPTED_200',
      };
    } catch {
      // The execution was created; only its name is unknown.
      return { outcome: 'START_AMBIGUOUS', executionReference: null, detail: 'RESPONSE_UNREADABLE' };
    }
  }
}
