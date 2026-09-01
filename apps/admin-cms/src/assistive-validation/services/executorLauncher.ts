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
type EnvironmentVarForStart = { name?: string; value?: string; secretRef?: string };
type ResourcesForStart = { cpu?: number; memory?: string; ephemeralStorage?: string };
type JobExecutionContainerForStart = {
  name?: string;
  image?: string;
  command?: string[];
  args?: string[];
  env?: EnvironmentVarForStart[];
  resources?: ResourcesForStart;
};
type JobExecutionTemplateForStart = {
  containers: JobExecutionContainerForStart[];
  initContainers?: JobExecutionContainerForStart[];
};
type JobTemplateFromGet = {
  containers?: unknown;
  initContainers?: unknown;
  volumes?: unknown;
};

export type PreparedExecution = {
  readonly requestBody: JobExecutionTemplateForStart;
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

const EXECUTION_TEMPLATE_FIELDS = new Set(['containers', 'initContainers']);
const EXECUTION_CONTAINER_FIELDS = new Set(['name', 'image', 'command', 'args', 'env', 'resources']);
const ENVIRONMENT_VARIABLE_FIELDS = new Set(['name', 'value', 'secretRef']);
const RESOURCE_FIELDS = new Set(['cpu', 'memory', 'ephemeralStorage']);

const EXPECTED_WORKER_COMMAND = [
  'npm', 'run', 'run:assistive-worker:on-demand', '--workspace=apps/admin-cms',
] as const;

function hasValue(container: JobExecutionContainerForStart, name: string, expected: string): boolean {
  const matches = (container.env ?? []).filter((entry) => entry.name === name);
  return matches.length === 1
    && matches[0].value === expected
    && matches[0].secretRef === undefined;
}

function hasSecretReference(container: JobExecutionContainerForStart, name: string): boolean {
  const matches = (container.env ?? []).filter((entry) => entry.name === name);
  return matches.length === 1
    && typeof matches[0].secretRef === 'string'
    && matches[0].secretRef.length > 0
    && matches[0].value === undefined;
}

function isCompleteWorkerTemplate(
  container: JobExecutionContainerForStart,
  expectedWorkerInstanceId: string,
): boolean {
  return JSON.stringify(container.command) === JSON.stringify(EXPECTED_WORKER_COMMAND)
    && container.resources?.cpu === 2
    && (container.resources.memory === '4Gi' || container.resources.memory === '4.0Gi')
    && hasValue(container, 'CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED', 'true')
    && hasValue(container, 'CAPSTONE_ASSISTIVE_EXECUTION_MODE', 'ON_DEMAND')
    && hasValue(container, 'CAPSTONE_ASSISTIVE_WORKER_INSTANCE_ID', expectedWorkerInstanceId)
    && hasSecretReference(container, 'SUPABASE_SECRET_KEY');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => allowed.has(field));
}

function isEnvironmentVarForStart(value: unknown): value is EnvironmentVarForStart {
  return isObject(value)
    && hasOnlyFields(value, ENVIRONMENT_VARIABLE_FIELDS)
    && (value.name === undefined || typeof value.name === 'string')
    && (value.value === undefined || typeof value.value === 'string')
    && (value.secretRef === undefined || typeof value.secretRef === 'string');
}

function isResourcesForStart(value: unknown): value is ResourcesForStart {
  return isObject(value)
    && hasOnlyFields(value, RESOURCE_FIELDS)
    && (value.cpu === undefined || typeof value.cpu === 'number')
    && (value.memory === undefined || typeof value.memory === 'string')
    && (value.ephemeralStorage === undefined || typeof value.ephemeralStorage === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isExecutionContainerForStart(value: unknown): value is JobExecutionContainerForStart {
  return isObject(value)
    && hasOnlyFields(value, EXECUTION_CONTAINER_FIELDS)
    && (value.name === undefined || typeof value.name === 'string')
    && (value.image === undefined || typeof value.image === 'string')
    && (value.command === undefined || isStringArray(value.command))
    && (value.args === undefined || isStringArray(value.args))
    && (value.env === undefined || (Array.isArray(value.env) && value.env.every(isEnvironmentVarForStart)))
    && (value.resources === undefined || isResourcesForStart(value.resources));
}

function projectContainerForStart(
  container: JobExecutionContainerForStart,
): JobExecutionContainerForStart {
  return {
    ...(container.name === undefined ? {} : { name: container.name }),
    ...(container.image === undefined ? {} : { image: container.image }),
    ...(container.command === undefined ? {} : { command: [...container.command] }),
    ...(container.args === undefined ? {} : { args: [...container.args] }),
    ...(container.env === undefined ? {} : { env: container.env.map((entry) => ({ ...entry })) }),
    ...(container.resources === undefined ? {} : { resources: { ...container.resources } }),
  };
}

function projectTemplateForStart(template: JobTemplateFromGet): JobExecutionTemplateForStart | null {
  if (!isObject(template) || !hasOnlyFields(template, EXECUTION_TEMPLATE_FIELDS)) return null;
  if (!Array.isArray(template.containers) || !template.containers.every(isExecutionContainerForStart)) return null;
  if (template.initContainers !== undefined
      && (!Array.isArray(template.initContainers) || !template.initContainers.every(isExecutionContainerForStart))) {
    return null;
  }
  return {
    containers: template.containers.map(projectContainerForStart),
    ...(template.initContainers === undefined
      ? {}
      : { initContainers: template.initContainers.map(projectContainerForStart) }),
  };
}

function withReservationEnvironment(
  container: JobExecutionContainerForStart,
  reservationToken: string,
  generation: number,
): JobExecutionContainerForStart {
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

    let job: { properties?: { template?: JobTemplateFromGet } };
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

    const template = job.properties?.template;
    if (!template) {
      return { ok: false, reason: 'JOB_TEMPLATE_INVALID' };
    }
    const containers = template?.containers;
    if (!Array.isArray(containers) || containers.length !== 1) {
      return { ok: false, reason: 'JOB_TEMPLATE_INVALID' };
    }
    // Jobs - Get returns JobTemplate, while the direct Jobs - Start REST endpoint accepts only
    // JobExecutionTemplate. Reject unsupported GET-only fields rather than silently dropping them.
    const executionTemplate = projectTemplateForStart(template);
    if (!executionTemplate) {
      return { ok: false, reason: 'JOB_TEMPLATE_UNSUPPORTED_FOR_EXECUTION_OVERRIDE' };
    }
    const matching = executionTemplate.containers.filter((container) =>
      typeof container.image === 'string'
      && container.image.endsWith(`@${this.config.expectedImageDigest}`));
    if (matching.length !== 1 || typeof matching[0].name !== 'string' || !matching[0].name) {
      return { ok: false, reason: 'JOB_IMAGE_DIGEST_MISMATCH' };
    }
    if (!hasValue(matching[0], 'CAPSTONE_DEPLOYMENT_VERSION', this.config.expectedDeploymentVersion)) {
      return { ok: false, reason: 'JOB_DEPLOYMENT_MISMATCH' };
    }
    if (!hasValue(matching[0], 'CAPSTONE_ASSISTIVE_IMAGE_DIGEST', this.config.expectedImageDigest)
        || !isCompleteWorkerTemplate(matching[0], this.config.jobName)) {
      return { ok: false, reason: 'JOB_TEMPLATE_INVALID' };
    }

    return {
      ok: true,
      prepared: {
        containerName: matching[0].name,
        credential: token,
        requestBody: executionTemplate,
      },
    };
  }

  async start(
    prepared: PreparedExecution,
    reservationToken: string,
    generation: number,
  ): Promise<StartResult> {
    const body = prepared.requestBody;
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
