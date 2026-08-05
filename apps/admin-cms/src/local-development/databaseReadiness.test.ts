import { describe, expect, it } from 'vitest';
import { classifyLocalStack, parseDatabaseContainerObservation } from './localStackState';

describe('database-specific readiness contract', () => {
  it('does not require optional services for reset readiness', () => {
    expect(classifyLocalStack({ available: true, states: Array(11).fill('running') })).toBe('RUNNING');
  });
  it('fails closed for ambiguous project evidence', () => {
    expect(classifyLocalStack({ available: false, states: [] })).toBe('UNKNOWN');
  });
  it('treats restarting project evidence as degraded rather than ready', () => {
    expect(classifyLocalStack({ available: true, states: ['restarting'] })).toBe('STOPPED');
  });
  it('keeps unrelated container evidence out of the project observer contract', () => {
    expect(classifyLocalStack({ available: true, states: [] })).toBe('STOPPED');
  });
  it('parses the Docker CLI delimiter emitted by the project database probe', () => {
    expect(parseDatabaseContainerObservation('supabase_db_capstone-impact-platform|running\n')).toEqual([
      { container: 'supabase_db_capstone-impact-platform', state: 'running' },
    ]);
  });
});
