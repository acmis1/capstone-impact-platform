import { describe, expect, it } from 'vitest';
import { classifyLocalStack, expectedLocalContainerNames, parseDatabaseContainerObservation } from './localStackState';

const expectedNames = expectedLocalContainerNames('synthetic-project');
const runningContainers = expectedNames.map((name) => ({ name, state: 'running' }));

describe('database-specific readiness contract', () => {
  it('recognizes the complete configured local service set as running', () => {
    expect(classifyLocalStack({ available: true, containers: runningContainers }, expectedNames)).toBe('RUNNING');
  });
  it('fails closed for ambiguous project evidence', () => {
    expect(classifyLocalStack({ available: false, containers: [] }, expectedNames)).toBe('UNKNOWN');
  });
  it('treats restarting project evidence as degraded rather than ready', () => {
    expect(classifyLocalStack({
      available: true,
      containers: [{ name: expectedNames[0], state: 'restarting' }],
    }, expectedNames)).toBe('DEGRADED');
  });
  it('keeps unrelated container evidence out of the project observer contract', () => {
    expect(classifyLocalStack({ available: true, containers: [] }, expectedNames)).toBe('STOPPED');
  });
  it('parses the Docker CLI delimiter emitted by the project database probe', () => {
    expect(parseDatabaseContainerObservation('supabase_db_capstone-impact-platform|running\n')).toEqual([
      { container: 'supabase_db_capstone-impact-platform', state: 'running' },
    ]);
  });
});
