import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(input: string): unknown };
const prohibited = /stu[d]ents?/i;
const frozenSyntheticOcrEvidence = /^(?:tools\/assistive-validation-benchmark\/(?:ocr-productionization\/corpus\/(?:calibration|holdout)|ocr-iteration2-calibration\/corpus\/calibration)\.json|docs\/assistive-validation\/evidence\/ocr-productionization-report\.json)$/;

function trackedFiles(repoRoot: string): string[] {
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

export function checkTerminology(repoRoot = path.resolve(__dirname, '../../../../')): string[] {
  const failures: string[] = [];
  for (const file of trackedFiles(repoRoot)) {
    if (prohibited.test(file)) failures.push(`${file}: filename`);
    // These machine files contain explicitly synthetic poster ground truth and immutable OCR
    // output. Product copy and all other repository content remain subject to the terminology gate.
    if (frozenSyntheticOcrEvidence.test(file)) continue;
    const absolutePath = path.join(repoRoot, file);
    const bytes = fs.readFileSync(absolutePath);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (prohibited.test(line)) failures.push(`${file}:${index + 1}`);
    });
  }
  return failures;
}

const yamlFiles = [
  '.github/workflows/ci.yml',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/ISSUE_TEMPLATE/task.yml',
];

export function checkYaml(repoRoot = path.resolve(__dirname, '../../../../')): string[] {
  const failures: string[] = [];
  for (const file of yamlFiles) {
    try {
      yaml.load(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message.split('\n')[0] : 'invalid YAML'}`);
    }
  }
  return failures;
}

function decodedPath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function checkMarkdownLinks(repoRoot = path.resolve(__dirname, '../../../../')): string[] {
  const failures: string[] = [];
  for (const file of trackedFiles(repoRoot).filter((entry) => /\.md$/i.test(entry))) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const linkPattern = /!?\[[^\]]*\]\(([^\s)]+(?:\s+[^)]*)?)\)/g;
    for (const match of source.matchAll(linkPattern)) {
      let target = match[1].trim().replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '');
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      target = decodedPath(target.split('#', 1)[0]);
      if (!target) continue;
      const resolved = target.startsWith('/')
        ? path.join(repoRoot, target.slice(1))
        : path.resolve(path.dirname(path.join(repoRoot, file)), target);
      if (!fs.existsSync(resolved)) failures.push(`${file}: ${match[1]}`);
    }
  }
  return failures;
}

function run(name: string, checker: () => string[]) {
  const failures = checker();
  if (failures.length) {
    console.error(`${name} failed:`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`${name} passed.`);
  }
}

const command = process.argv[2];
if (command === 'terminology') run('Terminology check', checkTerminology);
else if (command === 'yaml') run('YAML check', checkYaml);
else if (command === 'markdown-links') run('Markdown link check', checkMarkdownLinks);
else if (command) throw new Error(`Unknown repository check: ${command}`);
