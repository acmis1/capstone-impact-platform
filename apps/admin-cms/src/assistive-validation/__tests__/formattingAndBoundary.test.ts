import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formattingInformation } from '../deterministic/formatting';
import { assistiveCheckResultSchema, createAssistiveCheckResult } from '../domain/evidence';

describe('formatting information and purity boundary', () => {
  it('reports bounded non-blocking formatting hints only', () => {
    const findings = formattingInformation('  A\t\tvalue\n\n\nwith\uFFFD replacement  ');
    expect(findings.every((finding) => finding.classification === 'NON_BLOCKING' && finding.outcome === 'INFORMATION')).toBe(true);
    expect(findings.map((finding) => finding.reasonCode)).toEqual(expect.arrayContaining(['SUSPICIOUS_CONTROL_CHARACTERS', 'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE']));
  });

  it.each(['\u0000', '\u0007', '\u001F', '\u007F'])('reports prohibited control characters without leaking %j into evidence', (control) => {
    const findings = formattingInformation(`Project${control} text`);
    const suspicious = findings.find((finding) => finding.reasonCode === 'SUSPICIOUS_CONTROL_CHARACTERS');

    expect(suspicious).toBeDefined();
    expect(() => formattingInformation(`Project${control} text`)).not.toThrow();
    expect(assistiveCheckResultSchema.safeParse(suspicious).success).toBe(true);
    expect(suspicious?.evidenceExcerpt).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  });

  it('keeps replacement characters, tabs, and line breaks visible in valid plain-text evidence', () => {
    const [finding] = formattingInformation('Project\ttext\nwith\uFFFD replacement');
    expect(finding.reasonCode).toBe('SUSPICIOUS_CONTROL_CHARACTERS');
    expect(finding.evidenceExcerpt).toBe('Project\ttext\nwith\uFFFD replacement');
  });

  it('continues to reject raw prohibited controls at the strict evidence schema boundary', () => {
    const [finding] = formattingInformation(' Project text');
    expect(assistiveCheckResultSchema.safeParse({ ...finding, evidenceExcerpt: 'Project\u0000 text' }).success).toBe(false);
    expect(() => createAssistiveCheckResult({ ...finding, evidenceExcerpt: 'Project\u0000 text' })).toThrow();
  });

  it('imports no project mutation, approval, publication, archive, or Duda boundary', () => {
    const root = join(process.cwd(), 'src', 'assistive-validation');
    const files = readdirSync(root, { recursive: true }).filter((entry) => String(entry).endsWith('.ts') && !String(entry).includes('__tests__'));
    for (const file of files) {
      const source = readFileSync(join(root, String(file)), 'utf8');
      // `../../` is the domain boundary itself: Phase 3 added an in-domain repositories/ directory,
      // so the rule is now that no assistive module may escape src/assistive-validation at all.
      expect(source).not.toMatch(/from\s+['"][^'"]*(projects|workflow|publication|duda|\.\.\/\.\.\/)[^'"]*['"]/i);
    }
  });
});
