import assert from 'node:assert/strict';
import test from 'node:test';

import { formatFindings, loadSecretScanConfig, scanRepository, scanText } from './secret-scan.mjs';

const config = loadSecretScanConfig();

test('detects a high-signal provider token without returning its value', () => {
  const value = ['ghp_', 'a'.repeat(36)].join('');
  const findings = scanText('src/example.ts', `const credential = '${value}';`, config);
  assert.deepEqual(findings, [{ ruleId: 'github-token', path: 'src/example.ts', line: 1 }]);
  assert.equal(JSON.stringify(findings).includes(value), false);
  assert.equal(formatFindings(findings).join('\n').includes(value), false);
});

test('detects generic hard-coded credential assignments', () => {
  const value = ['production', '-', 'credential', '-', 'material'].join('');
  const findings = scanText('src/example.ts', `client_secret = '${value}'`, config);
  assert.deepEqual(findings, [
    { ruleId: 'generic-credential-assignment', path: 'src/example.ts', line: 1 },
  ]);
});

test('allows explicit synthetic values and evidence paths for only the generic rule', () => {
  const synthetic = ['synthetic', '-', 'credential', '-', 'for', '-', 'test'].join('');
  assert.deepEqual(
    scanText('src/example.test.ts', `password = '${synthetic}'`, config),
    [],
  );

  const generic = ['opaque', '-', 'benchmark', '-', 'fixture', '-', 'value'].join('');
  assert.deepEqual(
    scanText(
      'docs/assistive-validation/evidence/run.json',
      `auth_token = '${generic}'`,
      config,
    ),
    [],
  );

  const providerToken = ['npm_', 'b'.repeat(36)].join('');
  assert.deepEqual(
    scanText('docs/assistive-validation/evidence/run.json', providerToken, config),
    [{
      ruleId: 'npm-token',
      path: 'docs/assistive-validation/evidence/run.json',
      line: 1,
    }],
  );
});

test('current tracked and untracked repository content passes', () => {
  assert.deepEqual(scanRepository(), []);
});
