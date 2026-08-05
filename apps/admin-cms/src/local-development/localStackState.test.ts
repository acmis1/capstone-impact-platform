import { describe, expect, it } from 'vitest';
import { classifyLocalStack } from './localStackState';

describe('local stack state observer', () => {
  it('classifies the complete required container set as running', () => {
    expect(classifyLocalStack({ available: true, states: Array(11).fill('running') })).toBe('RUNNING');
  });
  it('classifies no running project containers as stopped', () => {
    expect(classifyLocalStack({ available: true, states: ['exited'] })).toBe('STOPPED');
  });
  it('fails closed for a partial project stack', () => {
    expect(classifyLocalStack({ available: true, states: Array(10).fill('running') })).toBe('DEGRADED');
  });
  it('fails closed when Docker is unavailable', () => {
    expect(classifyLocalStack({ available: false, states: [] })).toBe('UNKNOWN');
  });
});
