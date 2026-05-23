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
    'background', 'solution', 'posterText', 'teamMembers', 'citations',
    'snapshots'
  ];

  const forbidden = [
    'status', 'internalNotes', 'lastUpdated', 'adminId', 'validationErrors',
    'validationWarnings', 'staffNotes', 'privateNotes', 'reviewNotes',
    'missingItems', 'previewUrl', 'previewSentAt', 'studentConfirmedAt',
    'publishedAt', 'archivedAt', 'archiveReason', 'validationFlags', 'ocrStatus',
    'importBatchId', 'sourceFolder', 'sampleImportId', 'packageValidation'
  ];

  let errors = 0;
  let warnings = 0;

  if (!Array.isArray(projects)) {
    console.error('FAIL: Feed is not a JSON array');
    process.exit(1);
  }

  const urlPattern = /^(https?:\/\/)[^\s/$.?#].[^\s]*$/i;

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

    // 3. Poster Asset Validation (poster OR posterPdf is required)
    if (!p.poster && !p.posterPdf) {
      console.error(`[Project ${pId}] Error: A project must have at least one public poster asset (poster or posterPdf must not be empty).`);
      errors++;
    } else if (!p.poster || !p.posterPdf) {
      console.log(`[Project ${pId}] WARNING: Only one poster asset provided: ${p.poster ? 'Poster Image' : 'Poster PDF'}. Both are preferred but not mandatory.`);
      warnings++;
    }

    // 4. Accessibility Text Validation (Warning if missing, not error)
    if (!p.accessibilityText || p.accessibilityText.trim() === '') {
      console.log(`[Project ${pId}] WARNING: Missing accessibility text (accessibilityText).`);
      warnings++;
    }

    // 5. URL Format Checks
    const checkUrl = (url, fieldName) => {
      if (url && !urlPattern.test(url)) {
        console.error(`[Project ${pId}] Invalid URL format for ${fieldName}: "${url}"`);
        errors++;
      }
    };
    checkUrl(p.poster, 'poster');
    checkUrl(p.posterPdf, 'posterPdf');
    checkUrl(p.videoUrl, 'videoUrl');
    checkUrl(p.demoUrl, 'demoUrl');
    checkUrl(p.repositoryUrl, 'repositoryUrl');
    if (Array.isArray(p.snapshots)) {
      p.snapshots.forEach((snap, snapIdx) => {
        checkUrl(snap, `snapshots[${snapIdx}]`);
      });
    }

    // 6. Layout Configuration Validation
    if (p.layoutConfig) {
      if (typeof p.layoutConfig !== 'object' || Array.isArray(p.layoutConfig)) {
        console.error(`[Project ${pId}] layoutConfig must be an object`);
        errors++;
      } else {
        const { templateId, featuredMedia, sectionOrder, hiddenSections } = p.layoutConfig;

        const validTemplates = ['poster_showcase', 'technical_detail', 'media_rich'];
        if (templateId && !validTemplates.includes(templateId)) {
          console.error(`[Project ${pId}] Invalid layoutConfig.templateId: "${templateId}". Must be one of: ${validTemplates.join(', ')}`);
          errors++;
        }

        const validMedia = ['poster', 'video', 'snapshots', 'none'];
        if (featuredMedia && !validMedia.includes(featuredMedia)) {
          console.error(`[Project ${pId}] Invalid layoutConfig.featuredMedia: "${featuredMedia}". Must be one of: ${validMedia.join(', ')}`);
          errors++;
        }

        if (sectionOrder && !Array.isArray(sectionOrder)) {
          console.error(`[Project ${pId}] layoutConfig.sectionOrder must be an array`);
          errors++;
        }

        if (hiddenSections && !Array.isArray(hiddenSections)) {
          console.error(`[Project ${pId}] layoutConfig.hiddenSections must be an array`);
          errors++;
        }
      }
    }

    // 7. External Links Validation
    if (p.externalLinks) {
      if (!Array.isArray(p.externalLinks)) {
        console.error(`[Project ${pId}] externalLinks must be an array of link objects`);
        errors++;
      } else {
        p.externalLinks.forEach((link, linkIdx) => {
          if (typeof link !== 'object' || !link.label || !link.url) {
            console.error(`[Project ${pId}] Invalid externalLink at index ${linkIdx}: must contain both label and url`);
            errors++;
          } else {
            checkUrl(link.url, `externalLinks[${linkIdx}].url`);
          }
        });
      }
    }

    // 8. Basic Field Type & Non-Emptiness checks
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
