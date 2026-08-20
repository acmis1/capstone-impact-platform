import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formattingInformation } from '../deterministic/formatting';

describe('formatting information and purity boundary', () => {
  it('reports bounded non-blocking formatting hints only', () => {
    const findings = formattingInformation('  A\t\tvalue\n\n\nwith\uFFFD replacement  ');
    expect(findings.every((finding) => finding.classification === 'NON_BLOCKING' && finding.outcome === 'INFORMATION')).toBe(true);
    expect(findings.map((finding) => finding.reasonCode)).toEqual(expect.arrayContaining(['SUSPICIOUS_CONTROL_CHARACTERS', 'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE']));
  });

  it('imports no project mutation, approval, publication, archive, or Duda boundary', () => {
    const root = join(process.cwd(), 'src', 'assistive-validation');
    const files = readdirSync(root, { recursive: true }).filter((entry) => String(entry).endsWith('.ts') && !String(entry).includes('__tests__'));
    for (const file of files) {
      const source = readFileSync(join(root, String(file)), 'utf8');
      expect(source).not.toMatch(/from\s+['"][^'"]*(projects|workflow|publication|duda|repositories)[^'"]*['"]/i);
    }
  });
});
