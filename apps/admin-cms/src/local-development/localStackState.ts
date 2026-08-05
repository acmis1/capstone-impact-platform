import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type LocalStackState = 'RUNNING' | 'STOPPED' | 'DEGRADED' | 'UNKNOWN';

export interface DockerObservation {
  available: boolean;
  states: string[];
}

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
    const output = execFileSync('docker', ['ps', '-a', '--filter', `name=${projectId}`, '--format', '{{.State}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { available: true, states: output.split(/\r?\n/).filter(Boolean) };
  } catch {
    return { available: false, states: [] };
  }
}

/** The pinned local configuration starts eleven required containers; disabled services are excluded. */
export function classifyLocalStack(observation: DockerObservation, requiredRunning = 11): LocalStackState {
  if (!observation.available) return 'UNKNOWN';
  const running = observation.states.filter((state) => state === 'running').length;
  if (running === 0) return 'STOPPED';
  if (running >= requiredRunning) return 'RUNNING';
  return 'DEGRADED';
}

export function observeLocalStack(repoRoot: string): LocalStackState {
  const projectId = configuredProjectId(repoRoot);
  return projectId ? classifyLocalStack(observeDockerProject(projectId)) : 'UNKNOWN';
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
