import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('assistive duplicate shortlist Migration 0033 contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260821140000_assistive_duplicate_shortlist.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = content.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const compact = executable.replace(/\s+/g, ' ');

  it('is the sole new Migration 0033 and preserves migrations 1-32 byte-for-byte', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(34);
    expect(files[32]).toBe(filename);
    expect(() => execFileSync(
      'git',
      ['diff', '--exit-code', 'origin/main', '--', ...files.slice(0, 32).map(
        (inherited) => `infra/supabase/migrations/${inherited}`,
      )],
      { cwd: root, stdio: 'pipe' },
    )).not.toThrow();
  });

  it('keeps the side domain non-authoritative and does not grant direct table access', () => {
    expect(executable).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(projects|media_assets|approval_records|published_snapshots|validation_flags|import_batches)\b/i,
    );
    expect(executable).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*assistive_validation_/i);
    expect(executable).not.toMatch(/GRANT\s+EXECUTE[^;]*TO\s+(PUBLIC|anon|authenticated)/i);
    expect(executable).not.toMatch(/\b(TRUNCATE|DROP\s+TABLE|DROP\s+POLICY|DROP\s+INDEX)\b/i);
  });

  it('preserves closed v1 evidence and adds one closed v2 duplicateCandidates field', () => {
    expect(compact).toContain("'assistive-finding-evidence/v1', 'assistive-finding-evidence/v2'");
    expect(compact).toContain("WHEN 'assistive-finding-evidence/v1' THEN evidence ?& ARRAY[");
    expect(compact).toContain("WHEN 'assistive-finding-evidence/v2' THEN evidence ?& ARRAY[");
    expect(compact).toContain("'duplicateCandidates'");
    expect(compact).toContain("(evidence - ARRAY[");
    expect(compact).toContain("check_type <> 'DUPLICATE_SHORTLIST'");
    expect(compact).toContain("evidence ->> 'version' = 'assistive-finding-evidence/v1'");
  });

  it('enforces one non-blocking shortlist contract with no finding-level score', () => {
    expect(compact).toContain("'DUPLICATE_SHORTLIST'");
    expect(compact).toContain("'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST'");
    expect(compact).toContain("affected_field = 'project_content'");
    expect(compact).toContain('score_kind IS NULL');
    expect(compact).toContain('score_value IS NULL');
    expect(compact).not.toMatch(/'(BLOCKING|APPROVED|ACCEPTED|DUPLICATE_CONFIRMED|AUTO_MERGED)'/);
  });

  it('bounds candidate count, rank/order/uniqueness, text, key sets, scores, and controls', () => {
    expect(compact).toContain('pg_catalog.jsonb_array_length(p_candidates) NOT BETWEEN 1 AND 5');
    expect(compact).toContain("(v_candidate - v_keys) <> '{}'::jsonb");
    expect(compact).toContain("(v_candidate ->> 'rank')::numeric <> v_position");
    expect(compact).toContain("(v_candidate ->> 'publicId') = ANY(v_public_ids)");
    expect(compact).toContain("pg_catalog.length(v_candidate ->> 'publicId') NOT BETWEEN 1 AND 100");
    expect(compact).toContain("pg_catalog.length(v_candidate ->> 'title') > 200");
    expect(compact).toContain("pg_catalog.length(v_candidate ->> 'summaryExcerpt') > 240");
    expect(compact).toContain("(v_candidate ->> 'lexicalScore')::numeric NOT BETWEEN 0 AND 1");
    expect(compact).toContain("~ U&'[\\0001-\\0008\\000B\\000C\\000E-\\001F\\007F]'");
    for (const forbidden of ['databaseUuid', 'projectId', 'reviewedBy', 'storagePath', 'claimToken']) {
      expect(executable).not.toContain(`'${forbidden}'`);
    }
  });

  it('derives the shortlist outcome and reason from the candidate flags at both boundaries', () => {
    expect(compact).toContain('CREATE OR REPLACE FUNCTION public.assistive_duplicate_shortlist_has_exact_or_normalized(');
    expect(compact).toContain("'$[*] ? (@.exactContentMatch == true || @.normalizedTitleMatch == true)'");
    expect(compact).toContain('REVOKE ALL ON FUNCTION public.assistive_duplicate_shortlist_has_exact_or_normalized(jsonb) FROM PUBLIC, anon, authenticated, service_role');
    // Table CHECK: an incoherent shortlist cannot be inserted directly.
    expect(compact).toContain("THEN outcome = 'REVIEW' AND reason_code = 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT' ELSE outcome = 'INFORMATION' AND reason_code = 'LEXICAL_DUPLICATE_SHORTLIST' END");
    // Validation RPC: the same rule, expressed as an equivalence rather than an enumeration.
    expect(compact).toContain("(v_finding ->> 'outcome' = 'REVIEW') IS DISTINCT FROM v_has_exact_or_normalized");
    expect(compact).toContain("(v_finding ->> 'reasonCode' = 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT') IS DISTINCT FROM v_has_exact_or_normalized");
  });

  it('holds candidate flags, scores, and rank order to the selected deterministic ranker', () => {
    expect(compact).toContain('(v_exact AND NOT v_normalized)');
    expect(compact).toContain('OR (v_exact AND v_score <> 1)');
    expect(compact).toContain('OR (NOT v_exact AND v_score > 0.999)');
    expect(compact).toContain('v_position > 1 AND ( v_score > v_previous_score');
    expect(compact).toContain('v_score = v_previous_score AND (v_public_id COLLATE pg_catalog."C") <= (v_previous_public_id COLLATE pg_catalog."C")');
    // Ordering is validated against the supplied evidence only; similarity is never recomputed here.
    expect(executable).not.toMatch(/\b(similarity|levenshtein|word_similarity|pg_trgm|tsvector|to_tsvector|embedding|vector)\b/i);
  });

  it('replaces only the v1-enumerating persistence validator and RPC with hardened functions', () => {
    expect(compact).toContain('CREATE OR REPLACE FUNCTION public.is_valid_assistive_validation_findings(p_findings jsonb)');
    expect(compact).toContain('CREATE OR REPLACE FUNCTION public.persist_assistive_validation_run(');
    expect(compact).toContain('SECURITY DEFINER');
    expect(compact).toContain("SET search_path = ''");
    expect(compact).toContain('REVOKE ALL ON FUNCTION public.persist_assistive_validation_run(uuid, uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role');
    expect(compact).toContain('GRANT EXECUTE ON FUNCTION public.persist_assistive_validation_run(uuid, uuid, text, text, text, text, jsonb) TO service_role');
    expect(executable).not.toMatch(/\b(EXECUTE\s+['\"]|format\s*\(|quote_ident|quote_literal)\b/i);
  });
});
