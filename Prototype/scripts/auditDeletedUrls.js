import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILES_TO_AUDIT = [
  '../src/App.jsx',
  '../duda/bodyend.html',
  '../docs/demo-readiness.md',
  '../docs/deployment-staging.md',
  '../docs/duda-integration-plan.md',
  '../data/db.json',
  '../public/capstones-latest.json'
];

const DIRECTORIES_TO_AUDIT = [
  '../scratch'
];

// Fictional deleted project reference name pattern (avoid printing the literal reference in logs)
const DELETED_PROJECT_REF_PATTERN = /xojnnhilqaldxoilmxli/g;

export function runUrlAudit() {
  const auditResults = [];
  let totalMatches = 0;

  function auditFile(filePath) {
    const resolvedPath = path.resolve(__dirname, filePath);
    if (!fs.existsSync(resolvedPath)) return;

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      if (DELETED_PROJECT_REF_PATTERN.test(line)) {
        // Reset regex index for safety
        DELETED_PROJECT_REF_PATTERN.lastIndex = 0;
        const relativePath = path.relative(path.resolve(__dirname, '..'), resolvedPath);
        auditResults.push({
          file: relativePath,
          line: idx + 1
        });
        totalMatches++;
      }
    });
  }

  // Scan single files
  FILES_TO_AUDIT.forEach(file => auditFile(file));

  // Scan directories
  DIRECTORIES_TO_AUDIT.forEach((dir) => {
    const resolvedDir = path.resolve(__dirname, dir);
    if (!fs.existsSync(resolvedDir)) return;

    const items = fs.readdirSync(resolvedDir);
    items.forEach((item) => {
      const full = path.join(resolvedDir, item);
      if (fs.statSync(full).isFile() && item.endsWith('.js')) {
        auditFile(path.join(dir, item));
      }
    });
  });

  return {
    results: auditResults,
    totalMatches
  };
}

function main() {
  console.log('🔍 RUNNING AUDIT FOR OBSOLETE SUPABASE DOMAINS...');
  const audit = runUrlAudit();
  
  audit.results.forEach((match) => {
    console.log(`[MATCH] File: ${match.file} (Line ${match.line})`);
  });
  
  console.log(`----------------------------------------------------`);
  console.log(`Total Obsolete Reference Occurrences Found: ${audit.totalMatches}`);
  console.log('====================================================\n');
}

// Support direct execution via node
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
