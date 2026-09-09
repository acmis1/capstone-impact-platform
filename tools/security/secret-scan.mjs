import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '../..');
const defaultConfigPath = path.join(scriptDirectory, 'secret-scan.config.json');

const RULES = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { id: 'github-token', pattern: /\b(?:gh[opusr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{82,255})\b/g },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-live-key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}\b/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    id: 'generic-credential-assignment',
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key|service[_-]?role[_-]?key)\b\s*[:=]\s*['"]([^'"\\\r\n]{16,})['"]/gi,
    valueGroup: 1,
  },
];

function normalisePath(filePath) {
  return filePath.replaceAll('\\', '/');
}

export function loadSecretScanConfig(configPath = defaultConfigPath) {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    pathRules: parsed.allowlistedPathRules.map((entry) => ({
      ruleIds: new Set(entry.ruleIds),
      pattern: new RegExp(entry.pattern),
    })),
    valuePatterns: parsed.allowlistedValuePatterns.map((pattern) => new RegExp(pattern, 'i')),
  };
}

function isAllowed(filePath, ruleId, value, config) {
  if (config.valuePatterns.some((pattern) => pattern.test(value))) return true;
  return config.pathRules.some((entry) => entry.ruleIds.has(ruleId) && entry.pattern.test(filePath));
}

export function scanText(filePath, source, config = loadSecretScanConfig()) {
  const normalised = normalisePath(filePath);
  const findings = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const value = match[rule.valueGroup ?? 0];
      if (isAllowed(normalised, rule.id, value, config)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      findings.push({ ruleId: rule.id, path: normalised, line });
    }
  }
  return findings;
}

function repositoryFiles(repoRoot) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return output.toString('utf8').split('\0').filter(Boolean);
}

export function scanRepository(repoRoot = defaultRepoRoot, config = loadSecretScanConfig()) {
  const findings = [];
  for (const relativePath of repositoryFiles(repoRoot)) {
    const bytes = fs.readFileSync(path.join(repoRoot, relativePath));
    if (bytes.includes(0)) continue;
    findings.push(...scanText(relativePath, bytes.toString('utf8'), config));
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map(({ ruleId, path: filePath, line }) => `${ruleId} ${filePath}:${line}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanRepository();
  if (findings.length) {
    console.error(`Secret pattern scan failed with ${findings.length} finding(s).`);
    for (const line of formatFindings(findings)) console.error(`- ${line}`);
    console.error('Matched values are intentionally suppressed.');
    process.exitCode = 1;
  } else {
    console.log('Secret pattern scan passed. No high-signal secret patterns found.');
  }
}
