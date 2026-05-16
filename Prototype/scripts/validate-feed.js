import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FEED_PATH = path.join(__dirname, '..', 'public', 'capstones-latest.json');

console.log('--- PUBLIC FEED SCHEMA & DATA VALIDATION ---');

if (!fs.existsSync(FEED_PATH)) {
  console.error('FAIL: Public feed file not found at:', FEED_PATH);
  process.exit(1);
}

try {
  const projects = JSON.parse(fs.readFileSync(FEED_PATH, 'utf8'));
  
  const required = [
    'id', 'groupName', 'title', 'discipline', 'disciplines', 'year', 'industry', 
    'industryPartner', 'academicSupervisor', 'program', 'studyProgram', 'summary', 
    'background', 'solution', 'posterText', 'teamMembers', 'poster', 'citations',
    'snapshots'
  ];

  const forbidden = [
    'status', 'internalNotes', 'lastUpdated', 'adminId', 'validationErrors', 
    'validationWarnings', 'staffNotes', 'privateNotes', 'reviewNotes', 
    'missingItems', 'previewUrl', 'previewSentAt', 'studentConfirmedAt', 
    'publishedAt', 'archivedAt', 'archiveReason', 'validationFlags', 'ocrStatus', 
    'adminId', 'staffNotes', 'privateNotes'
  ];

  let errors = 0;
  let warnings = 0;

  if (!Array.isArray(projects)) {
    console.error('FAIL: Feed is not a JSON array');
    process.exit(1);
  }

  projects.forEach((p, idx) => {
    const pId = p.id || `index_${idx}`;
    
    // 1. Check Required Fields
    required.forEach(field => {
      if (p[field] === undefined) {
        console.error(`[Project ${pId}] Missing required field: ${field}`);
        errors++;
      }
    });

    // 2. Check Forbidden Fields
    forbidden.forEach(field => {
      if (p[field] !== undefined) {
        console.error(`[Project ${pId}] Forbidden internal field found: ${field}`);
        errors++;
      }
    });

    // 3. Type and Content Validation
    if (p.title && (typeof p.title !== 'string' || p.title.trim() === '')) {
      console.error(`[Project ${pId}] Invalid title: must be non-empty string`);
      errors++;
    }
    
    if (p.summary && (typeof p.summary !== 'string' || p.summary.trim() === '')) {
      console.error(`[Project ${pId}] Invalid summary: must be non-empty string`);
      errors++;
    }

    if (p.posterText && (typeof p.posterText !== 'string' || p.posterText.trim() === '')) {
      console.error(`[Project ${pId}] Invalid posterText: must be non-empty string`);
      errors++;
    }

    if (p.year && typeof p.year !== 'string' && typeof p.year !== 'number') {
      console.error(`[Project ${pId}] Invalid year: must be string or number`);
      errors++;
    }

    if (p.disciplines && !Array.isArray(p.disciplines)) {
      console.error(`[Project ${pId}] Invalid disciplines: must be an array`);
      errors++;
    }

    if (p.teamMembers && !Array.isArray(p.teamMembers)) {
      console.error(`[Project ${pId}] Invalid teamMembers: must be an array`);
      errors++;
    }

    if (p.citations && !Array.isArray(p.citations)) {
      console.error(`[Project ${pId}] Invalid citations: must be an array`);
      errors++;
    }

    if (p.snapshots && !Array.isArray(p.snapshots)) {
      console.error(`[Project ${pId}] Invalid snapshots: must be an array`);
      errors++;
    }

    if (p.posterPdf && (typeof p.posterPdf !== 'string' || p.posterPdf.trim() === '')) {
      console.error(`[Project ${pId}] Invalid posterPdf: must be a non-empty string`);
      errors++;
    }
  });

  if (errors === 0) {
    console.log(`PASS: Public feed validated successfully.`);
    console.log(`Records Checked: ${projects.length}`);
    console.log(`Required Fields Verified: ${required.length}`);
    console.log(`Forbidden Fields Blocked: ${forbidden.length}`);
  } else {
    console.error(`FAIL: Feed validation failed with ${errors} errors.`);
    process.exit(1);
  }
} catch (error) {
  console.error(`FAIL: Error reading or parsing feed: ${error.message}`);
  process.exit(1);
}
