import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSecurityPolicy, checkWorkflowSource } from './security-policy.mjs';

test('rejects mutable action tags and missing version comments', () => {
  const failures = checkWorkflowSource('example.yml', `on:\n  push:\npermissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n`);
  assert.equal(failures.some((failure) => failure.includes('40-character')), true);
  assert.equal(failures.some((failure) => failure.includes('version comment')), true);
});

test('rejects pull_request write permissions, secrets, and persisted checkout credentials', () => {
  const source = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  test:\n    permissions:\n      issues: write\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)} # v4.2.2\n      - run: echo \${{ secrets.EXAMPLE }}\n`;
  const failures = checkWorkflowSource('example.yml', source);
  assert.equal(failures.some((failure) => failure.includes('write permission')), true);
  assert.equal(failures.some((failure) => failure.includes('repository secrets')), true);
  assert.equal(failures.some((failure) => failure.includes('persists credentials')), true);
});

test('rejects pull-request-triggered CodeQL analysis', () => {
  const source = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  analyze:\n    permissions:\n      security-events: write\n    steps:\n      - uses: github/codeql-action/init@${'a'.repeat(40)} # v3.28.17\n        with:\n          build-mode: none\n`;
  const failures = checkWorkflowSource('codeql.yml', source);
  assert.equal(failures.some((failure) => failure.includes('write permission')), true);
  assert.equal(failures.some((failure) => failure.includes('must not run on pull_request')), true);
});

test('rejects a shallow assistive benchmark checkout', () => {
  const source = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)} # v4.2.2\n        with:\n          persist-credentials: false\n`;
  const failures = checkWorkflowSource('assistive-benchmark-ci.yml', source);
  assert.equal(failures.some((failure) => failure.includes('full Git history')), true);
});

test('rejects benchmark CI that omits the immutable historical freeze fetch', () => {
  const source = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)} # v4.2.2\n        with:\n          persist-credentials: false\n          fetch-depth: 0\n`;
  const failures = checkWorkflowSource('assistive-benchmark-ci.yml', source);
  assert.equal(failures.some((failure) => failure.includes('annotated v1 freeze tag')), true);
});

test('current workflows, update policy, and lockfiles pass', () => {
  assert.deepEqual(checkSecurityPolicy(), []);
});
