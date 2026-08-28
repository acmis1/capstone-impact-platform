import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('assistive language finding migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260828090000_assistive_language_findings.sql';
  const source = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = source.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const compact = executable.replace(/\s+/g, ' ');

  it('remains byte-identical to current main in the combined migration inventory', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(47);
    expect(files).toContain(filename);
    expect(() => execFileSync(
      'git',
      ['diff', '--exit-code', 'origin/main', '--', ...files
        .filter((file) => file !== '20260828170000_assistive_execution_control.sql')
        .map((file) => `infra/supabase/migrations/${file}`)],
      { cwd: root, stdio: 'pipe' },
    )).not.toThrow();
  });

  it('keeps language evidence non-authoritative and grants no browser or direct table access', () => {
    expect(executable).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(projects|media_assets|approval_records|published_snapshots|validation_flags|import_batches)\b/i,
    );
    expect(executable).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*assistive_validation_/i);
    expect(executable).not.toMatch(/GRANT\s+EXECUTE[^;]*TO\s+(PUBLIC|anon|authenticated)/i);
    expect(executable).not.toMatch(/\b(TRUNCATE|DROP\s+TABLE|DROP\s+POLICY|DROP\s+INDEX)\b/i);
    expect(compact).toContain("v_finding ->> 'classification' <> 'NON_BLOCKING'");
    expect(compact).toContain("check_type = 'LANGUAGE_SUGGESTION'");
    expect(compact).toContain("outcome = 'REVIEW'");
  });

  it('adds one closed v3 evidence shape without widening v1 or v2', () => {
    expect(compact).toContain("'assistive-finding-evidence/v1', 'assistive-finding-evidence/v2', 'assistive-finding-evidence/v3'");
    expect(compact).toContain("WHEN 'assistive-finding-evidence/v1' THEN");
    expect(compact).toContain("WHEN 'assistive-finding-evidence/v2' THEN");
    expect(compact).toContain("WHEN 'assistive-finding-evidence/v3' THEN public.is_valid_assistive_language_evidence(evidence)");
    for (const constraint of [
      'check_assistive_finding_evidence_excerpt', 'check_assistive_finding_evidence_values',
      'check_assistive_finding_evidence_page_number', 'check_assistive_finding_evidence_bounding_box',
    ]) {
      expect(compact).toContain(`DROP CONSTRAINT ${constraint}`);
      expect(compact).toContain(`ADD CONSTRAINT ${constraint}`);
    }
    expect(compact.match(/evidence ->> 'version' = 'assistive-finding-evidence\/v3'/g)?.length)
      .toBeGreaterThanOrEqual(4);
    for (const key of [
      'startOffset', 'endOffset', 'offsetUnit', 'originalSourceSpan', 'contextExcerpt',
      'languageCategory', 'ruleId', 'providerId', 'providerVersion', 'suggestions',
      'explanation', 'inputHash', 'pipelineVersion', 'policySha256',
    ]) expect(compact).toContain(`'${key}'`);
    expect(compact).toContain("(p_evidence - v_keys) <> '{}'::jsonb");
  });

  it('bounds and coheres canonical spans, suggestions, provider, policy, and run identity', () => {
    expect(compact).toContain("p_evidence ->> 'offsetUnit' <> 'UNICODE_CODE_POINTS'");
    expect(compact).toContain("(p_evidence ->> 'endOffset')::numeric < (p_evidence ->> 'startOffset')::numeric");
    expect(compact).toContain("pg_catalog.length(p_evidence ->> 'originalSourceSpan') <> (p_evidence ->> 'endOffset')::integer - (p_evidence ->> 'startOffset')::integer");
    expect(compact).toContain("pg_catalog.jsonb_array_length(p_evidence -> 'suggestions') NOT BETWEEN 0 AND 3");
    expect(compact).toContain("pg_catalog.length(v_suggestion #>> '{}') NOT BETWEEN 1 AND 100");
    expect(compact).toContain("pg_catalog.btrim(v_suggestion #>> '{}') = ''");
    expect(compact).toContain("reason_code <> 'LANGUAGE_SPELLING' OR pg_catalog.jsonb_array_length(evidence -> 'suggestions') >= 1");
    expect(compact).toContain("v_finding ->> 'reasonCode' = 'LANGUAGE_SPELLING' AND pg_catalog.jsonb_array_length(v_evidence -> 'suggestions') < 1");
    expect(compact).toContain("p_evidence ->> 'providerId' <> 'LANGUAGETOOL'");
    expect(compact).toContain("p_evidence ->> 'providerVersion' <> '6.6'");
    expect(compact).toContain("p_evidence ->> 'pipelineVersion' <> 'assistive-deterministic-checks/v3'");
    expect(compact).toContain("p_evidence ->> 'policySha256' <> '3984b958741a5103791524d48ba262a81ef829695ddc122a728c12cc3e689148'");
    expect(compact).toContain("finding #>> '{evidence,inputHash}' <> p_input_hash");
    expect(compact).toContain('CREATE TRIGGER assistive_language_finding_identity_guard BEFORE INSERT OR UPDATE OF run_id, evidence');
    expect(compact).toContain("NEW.evidence ->> 'pipelineVersion' IS DISTINCT FROM v_pipeline_version");
    expect(compact).toContain("IF v_finding ->> 'checkType' <> 'LANGUAGE_SUGGESTION' THEN");
    expect(compact).toContain("pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') NOT IN ('null', 'number')");
    expect(compact).toContain("v_box ->> 'unit' NOT IN ('PDF_POINTS_TOP_LEFT', 'IMAGE_PIXELS_TOP_LEFT')");
  });

  it('records explicit language degradation while preserving the existing job fencing protocol', () => {
    expect(compact).toContain("'LANGUAGE_PROVIDER_UNAVAILABLE', 'OCR_AND_LANGUAGE_INCOMPLETE'");
    expect(compact).toContain('v_job.claim_token IS DISTINCT FROM p_claim_token');
    expect(compact).toContain('v_job.lease_until <= v_now');
    expect(compact).toContain('v_job.cancellation_requested_at IS NOT NULL');
    expect(compact).toContain("'resultCode', 'CLAIM_LOST'");
    expect(compact).toContain("'resultCode', 'CANCELLED'");
    expect(executable).not.toMatch(/\b(EXECUTE\s+['"]|format\s*\(|quote_ident|quote_literal)\b/i);
  });
});
