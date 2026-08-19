import { describe, expect, it } from 'vitest';
import {
  classifyLocalStack,
  decideLocalSupabaseStart,
  expectedLocalContainerNames,
  parseDockerProjectInspection,
} from './localStackState';

const expectedNames = expectedLocalContainerNames('synthetic-project');
const runningContainers = expectedNames.map((name) => ({ name, state: 'running', health: 'healthy' }));

describe('local stack state observer', () => {
  it('classifies only the complete healthy required container identity set as running', () => {
    expect(classifyLocalStack({ available: true, containers: runningContainers }, expectedNames)).toBe('RUNNING');
  });
  it('classifies no running project containers as stopped', () => {
    expect(classifyLocalStack({
      available: true,
      containers: [{ name: expectedNames[0], state: 'exited' }],
    }, expectedNames)).toBe('STOPPED');
  });
  it('fails closed for missing, unexpected, restarting, or unhealthy project containers', () => {
    expect(classifyLocalStack({ available: true, containers: runningContainers.slice(1) }, expectedNames)).toBe('DEGRADED');
    expect(classifyLocalStack({
      available: true,
      containers: [...runningContainers.slice(1), { name: 'supabase_unexpected_synthetic-project', state: 'running' }],
    }, expectedNames)).toBe('DEGRADED');
    expect(classifyLocalStack({
      available: true,
      containers: runningContainers.map((container, index) => index === 0 ? { ...container, state: 'restarting' } : container),
    }, expectedNames)).toBe('DEGRADED');
    expect(classifyLocalStack({
      available: true,
      containers: runningContainers.map((container, index) => index === 0 ? { ...container, health: 'unhealthy' } : container),
    }, expectedNames)).toBe('DEGRADED');
  });
  it('fails closed when Docker is unavailable', () => {
    expect(classifyLocalStack({ available: false, containers: [] }, expectedNames)).toBe('UNKNOWN');
  });

  it('parses exact container identity, state, and optional Docker health', () => {
    expect(parseDockerProjectInspection([
      `${JSON.stringify('/supabase_db_synthetic-project')}|${JSON.stringify({ Status: 'running', Health: { Status: 'healthy' } })}`,
      `${JSON.stringify('/supabase_vector_synthetic-project')}|${JSON.stringify({ Status: 'running' })}`,
    ].join('\n'))).toEqual([
      { name: 'supabase_db_synthetic-project', state: 'running', health: 'healthy' },
      { name: 'supabase_vector_synthetic-project', state: 'running' },
    ]);
  });
});

describe('local start reconciliation decision', () => {
  it('uses verification-only only for a fully running stack', () => {
    expect(decideLocalSupabaseStart('RUNNING')).toEqual({ mode: 'VERIFY_EXISTING', ownsCleanup: false });
  });

  it('runs the CLI for a degraded stack without taking cleanup ownership', () => {
    expect(decideLocalSupabaseStart('DEGRADED')).toEqual({ mode: 'RUN_CLI', ownsCleanup: false });
  });

  it('runs the CLI for stopped and unknown states with conservative ownership', () => {
    expect(decideLocalSupabaseStart('STOPPED')).toEqual({ mode: 'RUN_CLI', ownsCleanup: true });
    expect(decideLocalSupabaseStart('UNKNOWN')).toEqual({ mode: 'RUN_CLI', ownsCleanup: false });
  });
});
