import { describe, expect, it } from 'vitest';

import {
  ASSISTIVE_LANGUAGE_POLICY_SHA256,
  persistedAssistiveFindingSchema,
} from '../domain/persistenceContract';
import {
  maskLanguageText,
  toPersistedLanguageFindings,
  utf16OffsetToCodePoint,
  type LanguageToolRawMatch,
} from '../domain/languagePolicy';

const INPUT_HASH = 'a'.repeat(64);

const match = (overrides: Partial<LanguageToolRawMatch> = {}): LanguageToolRawMatch => ({
  offset: 0,
  length: 7,
  message: 'Possible spelling mistake found.',
  ruleId: 'MORFOLOGIK_RULE_EN_AU',
  categoryId: 'TYPOS',
  replacements: ['receive'],
  ...overrides,
});

describe('frozen production language policy', () => {
  it('masks machine data without changing provider UTF-16 length', () => {
    const source = 'Emoji 😀 stays; read `projectMetadataHash` at https://example.invalid/a.';
    const masked = maskLanguageText(source);
    expect(masked.text.length).toBe(source.length);
    expect(masked.text).not.toContain('projectMetadataHash');
    expect(masked.text).not.toContain('https://');
    expect(masked.spans).toHaveLength(2);
  });

  it('converts only valid UTF-16 boundaries to Unicode code points', () => {
    const source = 'A😀B';
    expect(source.length).toBe(4);
    expect(utf16OffsetToCodePoint(source, 0)).toBe(0);
    expect(utf16OffsetToCodePoint(source, 3)).toBe(2);
    expect(utf16OffsetToCodePoint(source, 4)).toBe(3);
    expect(() => utf16OffsetToCodePoint(source, 2)).toThrow('LANGUAGE_OFFSET_SPLITS_SURROGATE');
  });

  it('suppresses exact approved technical terms and generic technical shapes', () => {
    expect(toPersistedLanguageFindings({
      field: 'summary', source: 'LanguageTool', inputHash: INPUT_HASH,
      matches: [match({ length: 12, replacements: ['Language Tool'] })],
    })).toEqual([]);
    expect(toPersistedLanguageFindings({
      field: 'summary', source: 'TimescaleDB', inputHash: INPUT_HASH,
      matches: [match({ length: 11, replacements: ['Timescale DB'] })],
    })).toEqual([]);
  });

  it('uses the unique approved near-miss as the only correction', () => {
    const findings = toPersistedLanguageFindings({
      field: 'summary', source: 'LangaugeTool helps staff.', inputHash: INPUT_HASH,
      matches: [match({ length: 12, replacements: ['Language Tool', 'LanguageTool'] })],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkType: 'LANGUAGE_SUGGESTION',
      reasonCode: 'LANGUAGE_SPELLING',
      affectedField: 'summary',
      origin: 'LOCAL_LANGUAGE_PROVIDER',
      evidence: {
        version: 'assistive-finding-evidence/v3',
        startOffset: 0,
        endOffset: 12,
        originalSourceSpan: 'LangaugeTool',
        suggestions: ['LanguageTool'],
        inputHash: INPUT_HASH,
        policySha256: ASSISTIVE_LANGUAGE_POLICY_SHA256,
      },
    });
  });

  it('retains only plausible bounded spelling replacements', () => {
    const findings = toPersistedLanguageFindings({
      field: 'background', source: 'recieve updates', inputHash: INPUT_HASH,
      matches: [match({
        length: 7,
        replacements: ['receive', 'remote unrelated phrase', 'receive', 'x'.repeat(101)],
      })],
    });
    expect(findings[0].evidence).toMatchObject({ suggestions: ['receive'] });
  });

  it('applies spelling plausibility only after the frozen first-three provider bound', () => {
    expect(toPersistedLanguageFindings({
      field: 'background', source: 'recieve updates', inputHash: INPUT_HASH,
      matches: [match({ replacements: ['banana', 'remote', 'unrelated', 'receive'] })],
    })).toEqual([]);
  });

  it('retains grammar evidence without a replacement and stores only bounded plain-text explanation', () => {
    const findings = toPersistedLanguageFindings({
      field: 'summary', source: 'project need review', inputHash: INPUT_HASH,
      matches: [match({
        ruleId: 'SUBJECT_VERB_AGREEMENT', categoryId: 'GRAMMAR', replacements: [],
        message: `<script>${'x'.repeat(400)}</script>\u0001`,
      })],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reasonCode: 'LANGUAGE_GRAMMAR',
      evidence: { suggestions: [] },
    });
    if (findings[0].evidence.version !== 'assistive-finding-evidence/v3') throw new Error('Expected v3 evidence.');
    expect(Array.from(findings[0].evidence.explanation)).toHaveLength(300);
    expect(findings[0].evidence.explanation).not.toMatch(/[<>\u0001]/);
  });

  it('keeps titles spelling-only and excludes findings overlapping masked spans', () => {
    expect(toPersistedLanguageFindings({
      field: 'title', source: 'project need review', inputHash: INPUT_HASH,
      matches: [match({
        length: 7, ruleId: 'SUBJECT_VERB_AGREEMENT', categoryId: 'GRAMMAR',
        message: 'Agreement.', replacements: ['project needs'],
      })],
    })).toEqual([]);
    expect(toPersistedLanguageFindings({
      field: 'summary', source: 'Read `recieve` safely.', inputHash: INPUT_HASH,
      matches: [match({ offset: 6, length: 7 })],
    })).toEqual([]);
  });

  it('rejects malformed, expanded, or offset-incoherent persisted evidence', () => {
    const finding = toPersistedLanguageFindings({
      field: 'solution', source: 'recieve updates', inputHash: INPUT_HASH,
      matches: [match()],
    })[0];
    expect(persistedAssistiveFindingSchema.safeParse(finding).success).toBe(true);
    expect(persistedAssistiveFindingSchema.safeParse({
      ...finding,
      evidence: { ...finding.evidence, rawProviderResponse: 'forbidden' },
    }).success).toBe(false);
    expect(persistedAssistiveFindingSchema.safeParse({
      ...finding,
      evidence: { ...finding.evidence, endOffset: 8 },
    }).success).toBe(false);
    expect(persistedAssistiveFindingSchema.safeParse({
      ...finding,
      evidence: { ...finding.evidence, suggestions: [] },
    }).success).toBe(false);
    expect(persistedAssistiveFindingSchema.safeParse({
      ...finding,
      evidence: { ...finding.evidence, suggestions: ['😀'.repeat(100)] },
    }).success).toBe(true);
    expect(persistedAssistiveFindingSchema.safeParse({
      ...finding,
      evidence: { ...finding.evidence, suggestions: ['😀'.repeat(101)] },
    }).success).toBe(false);
  });
});
