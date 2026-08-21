import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { Dialect, LocalLinter } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('A generated local input JSON path is required.');
const payload = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(payload.texts) || payload.texts.some((text) => typeof text !== 'string')) {
  throw new Error('Input must contain a texts array.');
}

const linter = new LocalLinter({ binary: binaryInlined, dialect: Dialect.Australian });
try {
  const setupStarted = performance.now();
  await linter.setup();
  const setupMs = performance.now() - setupStarted;
  const cases = [];
  for (const text of payload.texts) {
    const started = performance.now();
    const lints = await linter.lint(text, { language: 'plaintext' });
    const runtimeMs = performance.now() - started;
    cases.push({
      runtime_ms: runtimeMs,
      findings: lints.map((lint) => ({
        start: lint.span().start,
        end: lint.span().end,
        message: lint.message(),
        kind: lint.lint_kind_pretty(),
        replacements: lint.suggestions().map((suggestion) => suggestion.get_replacement_text()),
      })),
    });
  }
  process.stdout.write(`${JSON.stringify({ setup_ms: setupMs, cases })}\n`);
} finally {
  await linter.dispose();
}
