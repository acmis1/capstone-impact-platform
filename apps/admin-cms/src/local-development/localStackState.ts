import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type LocalStackState = 'RUNNING' | 'STOPPED' | 'DEGRADED' | 'UNKNOWN';

export interface ProjectContainerObservation {
  name: string;
  state: string;
  health?: string;
}

export interface DockerObservation {
  available: boolean;
  containers: ProjectContainerObservation[];
}

export const REQUIRED_LOCAL_SUPABASE_SERVICES = [
  'studio',
  'pg_meta',
  'edge_runtime',
  'storage',
  'rest',
  'realtime',
  'inbucket',
  'auth',
  'kong',
  'analytics',
  'db',
] as const;

export function configuredProjectId(repoRoot: string): string | null {
  try {
    const config = fs.readFileSync(path.join(repoRoot, 'infra/supabase/config.toml'), 'utf8');
    return config.match(/^project_id\s*=\s*"([a-z0-9-]+)"\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function observeDockerProject(projectId: string): DockerObservation {
  try {
    const ids = execFileSync('docker', [
      'ps',
      '-a',
      '--filter',
      `label=com.supabase.cli.project=${projectId}`,
      '--format',
      '{{.ID}}',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split(/\r?\n/).filter(Boolean);
    if (ids.length === 0) return { available: true, containers: [] };
    const output = execFileSync('docker', [
      'inspect',
      '--format',
      '{{json .Name}}|{{json .State}}',
      ...ids,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { available: true, containers: parseDockerProjectInspection(output) };
  } catch {
    return { available: false, containers: [] };
  }
}

export function parseDockerProjectInspection(raw: string): ProjectContainerObservation[] {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('|');
      if (separator < 0) throw new Error('DOCKER_PROJECT_INSPECTION_INVALID');
      const rawName = JSON.parse(line.slice(0, separator)) as unknown;
      const rawState = JSON.parse(line.slice(separator + 1)) as {
        Status?: unknown;
        Health?: { Status?: unknown } | null;
      } | null;
      if (typeof rawName !== 'string' || typeof rawState?.Status !== 'string') {
        throw new Error('DOCKER_PROJECT_INSPECTION_INVALID');
      }
      const health = rawState.Health?.Status;
      if (health !== undefined && typeof health !== 'string') throw new Error('DOCKER_PROJECT_INSPECTION_INVALID');
      return {
        name: rawName.replace(/^\//, ''),
        state: rawState.Status,
        ...(health ? { health } : {}),
      };
    });
}

export function expectedLocalContainerNames(projectId: string): string[] {
  return REQUIRED_LOCAL_SUPABASE_SERVICES.map((service) => `supabase_${service}_${projectId}`);
}

export function classifyLocalStack(observation: DockerObservation, expectedNames: string[]): LocalStackState {
  if (!observation.available) return 'UNKNOWN';
  const active = observation.containers.filter((container) => container.state === 'running' || container.state === 'restarting');
  if (active.length === 0) return 'STOPPED';

  const byName = new Map(observation.containers.map((container) => [container.name, container]));
  const hasExactIdentitySet = observation.containers.length === expectedNames.length && byName.size === expectedNames.length;
  const allRequiredReady = hasExactIdentitySet && expectedNames.every((name) => {
    const container = byName.get(name);
    return container?.state === 'running' && (!container.health || container.health === 'healthy');
  });
  if (allRequiredReady) return 'RUNNING';
  return 'DEGRADED';
}

export function observeLocalStack(repoRoot: string): LocalStackState {
  const projectId = configuredProjectId(repoRoot);
  return projectId
    ? classifyLocalStack(observeDockerProject(projectId), expectedLocalContainerNames(projectId))
    : 'UNKNOWN';
}

export type LocalSupabaseStartDecision =
  | { mode: 'VERIFY_EXISTING'; ownsCleanup: false }
  | { mode: 'RUN_CLI'; ownsCleanup: boolean };

export function decideLocalSupabaseStart(state: LocalStackState): LocalSupabaseStartDecision {
  return state === 'RUNNING'
    ? { mode: 'VERIFY_EXISTING', ownsCleanup: false }
    : { mode: 'RUN_CLI', ownsCleanup: state === 'STOPPED' };
}

export type DatabaseReadiness = 'READY' | 'STARTING' | 'UNHEALTHY' | 'STOPPED' | 'UNKNOWN';

export function parseDatabaseContainerObservation(raw: string): { container: string; state: string }[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [container, state] = line.split('|');
      return { container, state };
    });
}

export function observeDatabaseReadiness(repoRoot: string): DatabaseReadiness {
  const projectId = configuredProjectId(repoRoot);
  if (!projectId) return 'UNKNOWN';
  try {
    const raw = execFileSync('docker', ['ps', '-a', '--filter', `name=supabase_db_${projectId}`, '--format', '{{.Names}}|{{.State}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const matches = parseDatabaseContainerObservation(raw);
    if (matches.length !== 1) return matches.length === 0 ? 'STOPPED' : 'UNKNOWN';
    const { container, state } = matches[0];
    if (state !== 'running') return state === 'restarting' ? 'STARTING' : 'STOPPED';
    try {
      execFileSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-p', '5432'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return 'READY';
    } catch {
      return 'STARTING';
    }
  } catch {
    return 'UNKNOWN';
  }
}
