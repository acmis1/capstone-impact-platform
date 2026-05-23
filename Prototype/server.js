import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { publishToCloud, getPublishedFeedStatus } from './utils/supabasePublisher.js';
import * as projectStore from './utils/projectStore.js';
import * as XLSX from 'xlsx';

dotenv.config();

// Deterministic hashing helpers for Duda Sync / fingerprinted state
const getPublicPayload = (project) => {
  if (!project) return {};
  const layout = project.layoutConfig || {};
  return {
    title: project.title || "",
    summary: project.summary || "",
    background: project.background || "",
    solution: project.solution || "",
    poster: project.poster || "",
    posterPdf: project.posterPdf || "",
    snapshots: Array.isArray(project.snapshots)
      ? project.snapshots
      : typeof project.snapshots === 'string'
        ? project.snapshots.split(/[\n,]/).map(s => s.trim()).filter(s => s !== '')
        : [],
    videoUrl: project.videoUrl || "",
    demoUrl: project.demoUrl || "",
    repositoryUrl: project.repositoryUrl || "",
    externalLinks: Array.isArray(project.externalLinks) ? project.externalLinks : [],
    accessibilityText: project.accessibilityText || "",
    teamMembers: Array.isArray(project.teamMembers)
      ? project.teamMembers
      : typeof project.teamMembers === 'string'
        ? project.teamMembers.split(',').map(s => s.trim()).filter(s => s !== '')
        : [],
    groupName: project.groupName || "",
    academicSupervisor: project.academicSupervisor || project.supervisor || "",
    industryPartner: project.industryPartner || "",
    industry: project.industry || "",
    program: project.program || project.studyProgram || "",
    discipline: project.discipline || "",
    year: String(project.year || ""),
    layoutConfig: {
      templateId: layout.templateId || "poster_showcase",
      featuredMedia: layout.featuredMedia || "poster",
      sectionOrder: Array.isArray(layout.sectionOrder) ? layout.sectionOrder : ["background", "solution", "snapshots", "video", "links"],
      hiddenSections: Array.isArray(layout.hiddenSections) ? layout.hiddenSections : []
    }
  };
};

const stableStringify = (obj) => {
  if (obj === null || obj === undefined) return '';
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
};

const fnv1a = (str) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const getPublicPayloadHash = (project) => {
  const payload = getPublicPayload(project);
  const stableStr = stableStringify(payload);
  return fnv1a(stableStr);
};

const fnv1aNumber = (str) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

const normalizeSlug = (value) => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
};

const sanitizeFileName = (value) => {
  const name = path.basename(String(value || '').replace(/\\/g, '/'));
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '') || 'file';
};

const normalizeUploadPath = (relativePath) => {
  const raw = String(relativePath || '').replace(/\\/g, '/').trim();
  if (!raw) throw new Error('Missing relative path for uploaded file.');
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error(`Unsafe upload path: ${raw}`);
  }

  const parts = raw.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.')) {
    throw new Error(`Unsafe upload path: ${raw}`);
  }
  return parts;
};

const isIgnoredSystemPath = (parts) => {
  return parts.some(part => part === '__MACOSX') ||
    ['.ds_store', 'thumbs.db'].includes((parts[parts.length - 1] || '').toLowerCase());
};

const contentTypeForFile = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.txt': 'text/plain; charset=utf-8',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json'
  };
  return types[ext] || 'application/octet-stream';
};

const parseManifest = (body, files) => {
  if (!body.manifest) return null;

  const manifest = JSON.parse(body.manifest);
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error('Import manifest must contain a files array.');
  }

  const queues = new Map();
  files.forEach(file => {
    const keys = [file.originalname, file.fieldname].filter(Boolean);
    keys.forEach(key => {
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push(file);
    });
  });

  return manifest.files.map((entry, index) => {
    const uploadName = entry.uploadName || entry.originalname || entry.name;
    const queue = queues.get(uploadName);
    const file = queue && queue.length > 0 ? queue.shift() : files[index];
    if (!file) throw new Error(`Manifest entry has no matching uploaded file: ${uploadName || index}`);
    return { file, relativePath: entry.relativePath };
  });
};

const buildImportEntries = (files, body) => {
  const pairs = parseManifest(body, files) || files.map(file => ({
    file,
    relativePath: file.originalname
  }));

  return pairs
    .map(({ file, relativePath }) => ({ file, parts: normalizeUploadPath(relativePath) }))
    .filter(entry => !isIgnoredSystemPath(entry.parts));
};

const stripCommonRoot = (entries) => {
  if (entries.length === 0) return { commonRoot: '', entries };

  const first = entries[0].parts[0];
  const hasCommonRoot = first && entries.every(entry => entry.parts[0] === first);
  if (!hasCommonRoot) return { commonRoot: '', entries };

  return {
    commonRoot: first,
    entries: entries
      .map(entry => ({ ...entry, parts: entry.parts.slice(1) }))
      .filter(entry => entry.parts.length > 0)
  };
};

const METADATA_FILES = ['project-details.xlsx', 'project-details.csv', 'project.json'];

const isMetadataFile = (filename) => {
  return METADATA_FILES.includes(filename.toLowerCase());
};

const groupProjectFolders = (entries, mode, commonRoot) => {
  const rootMetadata = entries.some(entry =>
    entry.parts.length === 1 && isMetadataFile(entry.parts[0])
  );

  if (mode === 'single') {
    if (rootMetadata) {
      return [{ folder: commonRoot || 'project', slug: normalizeSlug(commonRoot || 'project'), entries }];
    }

    const folderNames = new Set(entries.map(entry => entry.parts[0]).filter(Boolean));
    const projectFolders = [...folderNames].filter(folder =>
      entries.some(entry =>
        entry.parts[0] === folder &&
        entry.parts.length === 2 &&
        isMetadataFile(entry.parts[1])
      )
    );

    if (projectFolders.length !== 1) {
      throw new Error('Single import mode requires one project folder with project-details.xlsx, project-details.csv, or project.json.');
    }

    const folder = projectFolders[0];
    return [{
      folder,
      slug: normalizeSlug(folder),
      entries: entries
        .filter(entry => entry.parts[0] === folder)
        .map(entry => ({ ...entry, parts: entry.parts.slice(1) }))
    }];
  }

  const grouped = new Map();
  entries.forEach(entry => {
    const folder = entry.parts[0];
    if (!folder || entry.parts.length < 2) return;
    if (!grouped.has(folder)) grouped.set(folder, []);
    grouped.get(folder).push({ ...entry, parts: entry.parts.slice(1) });
  });

  return [...grouped.entries()].map(([folder, groupEntries]) => ({
    folder,
    slug: normalizeSlug(folder),
    entries: groupEntries
  }));
};

const findProjectFile = (projectEntries, relativePath) => {
  const target = relativePath.toLowerCase();
  return projectEntries.find(entry => entry.parts.join('/').toLowerCase() === target);
};

const deterministicProjectId = (year, slug) => {
  const yearNumber = parseInt(String(year || '').replace(/\D/g, '').slice(0, 4), 10) || new Date().getFullYear();
  const hash = fnv1aNumber(`${yearNumber}:${slug}`);
  let id = (yearNumber * 100000) + ((hash % 90000) + 10000);
  const protectedIds = new Set([2026101, 2026102, 2026103, 2026104, 2026105]);
  while (protectedIds.has(id)) id += 10000;
  return id;
};

const normalizeKey = (key) => {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
};

const normalizeTemplateId = (value) => {
  const normalized = normalizeKey(value);
  const layoutMap = {
    postershowcase: 'poster_showcase',
    posterfirstshowcase: 'poster_showcase',
    poster: 'poster_showcase',
    technicalreport: 'technical_detail',
    reportfirstlayout: 'technical_detail',
    technicaldetail: 'technical_detail',
    mediarichshowcase: 'media_rich',
    mediarich: 'media_rich',
    videoandgalleryshowcase: 'media_rich'
  };
  return layoutMap[normalized] || String(value || '').trim();
};

const normalizeFeaturedMedia = (value) => {
  const normalized = normalizeKey(value);
  const mediaMap = {
    auto: 'auto',
    poster: 'poster',
    gallery: 'gallery',
    projectsnapshots: 'gallery',
    snapshots: 'gallery',
    video: 'video'
  };
  return mediaMap[normalized] || String(value || '').trim();
};

const sanitizeMetadataObject = (rawObj) => {
  const metadata = {};
  const keyMap = {
    projecttitle: 'title',
    title: 'title',
    shortpublicsummary: 'summary',
    summary: 'summary',
    projectbackground: 'background',
    background: 'background',
    solutionimpact: 'solution',
    solution: 'solution',
    teammembers: 'teamMembers',
    team: 'teamMembers',
    groupname: 'groupName',
    group: 'groupName',
    supervisor: 'supervisor',
    academicsupervisor: 'supervisor',
    industrypartner: 'industryPartner',
    industrysector: 'industry',
    industry: 'industry',
    studyprogram: 'program',
    program: 'program',
    primarydiscipline: 'discipline',
    discipline: 'discipline',
    projectyear: 'year',
    year: 'year',
    showcaselayout: 'templateId',
    templateid: 'templateId',
    mainmediatofeature: 'featuredMedia',
    featuredmedia: 'featuredMedia',
    accessibilitytext: 'accessibilityText'
  };

  Object.entries(rawObj).forEach(([key, val]) => {
    const norm = normalizeKey(key);
    const targetKey = keyMap[norm];
    if (targetKey) {
      let cleanedVal = val === undefined || val === null ? '' : String(val).trim();
      if (targetKey === 'teamMembers') {
        cleanedVal = cleanedVal
          .split(/[,;]/)
          .map(name => name.trim())
          .filter(Boolean);
      }
      if (targetKey === 'templateId') {
        cleanedVal = normalizeTemplateId(cleanedVal);
      }
      if (targetKey === 'featuredMedia') {
        cleanedVal = normalizeFeaturedMedia(cleanedVal);
      }
      metadata[targetKey] = cleanedVal;
    }
  });

  const allKeys = [
    'title', 'summary', 'background', 'solution', 'teamMembers',
    'groupName', 'supervisor', 'industryPartner', 'industry',
    'program', 'discipline', 'year', 'templateId', 'featuredMedia',
    'accessibilityText'
  ];
  allKeys.forEach(k => {
    if (metadata[k] === undefined) {
      metadata[k] = k === 'teamMembers' ? [] : '';
    }
  });

  return metadata;
};

const parseXlsxMetadata = (buffer, warnings) => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  let sheet = workbook.Sheets['Project Details'];
  if (!sheet) {
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error('Excel workbook has no sheets');
    }
    sheet = workbook.Sheets[firstSheetName];
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (rows.length === 0) {
    throw new Error('Empty Excel worksheet');
  }

  const headers = rows[0].map(h => String(h || '').trim());
  const dataRows = rows.slice(1).filter(row => row.some(cell => cell !== undefined && cell !== null && String(cell).trim() !== ''));
  if (dataRows.length === 0) {
    throw new Error('Excel worksheet has headers but no data row');
  }
  if (dataRows.length > 1) {
    warnings.push('Excel file has multiple data rows. Only the first data row will be imported.');
  }

  const firstDataRow = dataRows[0];
  const rawObj = {};
  headers.forEach((header, index) => {
    if (!header) return;
    rawObj[header] = firstDataRow[index];
  });

  return sanitizeMetadataObject(rawObj);
};

const parseCsvMetadata = (buffer, warnings) => {
  const csvText = buffer.toString('utf8');
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentCell);
        currentCell = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        currentRow.push(currentCell);
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
  }
  if (currentCell !== '' || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  const cleanRows = rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
  if (cleanRows.length === 0) {
    throw new Error('Empty CSV file');
  }

  const headers = cleanRows[0];
  const dataRows = cleanRows.slice(1);
  if (dataRows.length === 0) {
    throw new Error('CSV has headers but no data row');
  }
  if (dataRows.length > 1) {
    warnings.push('CSV file has multiple data rows. Only the first data row will be imported.');
  }

  const firstDataRow = dataRows[0];
  const rawObj = {};
  headers.forEach((header, index) => {
    if (!header) return;
    rawObj[header] = firstDataRow[index];
  });

  return sanitizeMetadataObject(rawObj);
};

const validateAndPrepareProject = (projectFolder) => {
  const errors = [];
  const warnings = [];
  const entries = projectFolder.entries;

  const xlsxFile = findProjectFile(entries, 'project-details.xlsx');
  const csvFile = findProjectFile(entries, 'project-details.csv');
  const jsonFile = findProjectFile(entries, 'project.json');
  let metadata = null;

  if (xlsxFile) {
    try {
      metadata = parseXlsxMetadata(xlsxFile.file.buffer, warnings);
    } catch (err) {
      errors.push(`invalid XLSX: ${err.message}`);
    }
  } else if (csvFile) {
    try {
      metadata = parseCsvMetadata(csvFile.file.buffer, warnings);
    } catch (err) {
      errors.push(`invalid CSV: ${err.message}`);
    }
  } else if (jsonFile) {
    try {
      metadata = JSON.parse(jsonFile.file.buffer.toString('utf8'));
    } catch {
      errors.push('invalid JSON');
    }
  } else {
    errors.push('Missing project details file. Add project-details.xlsx, project-details.csv, or project.json.');
  }

  const posterImage = entries.find(entry => {
    const name = entry.parts.join('/').toLowerCase();
    return ['poster.png', 'poster.jpg', 'poster.jpeg', 'poster.webp'].includes(name);
  });
  const posterPdf = findProjectFile(entries, 'poster.pdf');
  const accessibilityFile = findProjectFile(entries, 'accessibility.txt');
  const snapshotFiles = entries.filter(entry =>
    entry.parts.length === 2 &&
    entry.parts[0].toLowerCase() === 'snapshots' &&
    ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(entry.parts[1]).toLowerCase())
  );
  const mediaFiles = entries.filter(entry =>
    entry.parts.length === 2 && entry.parts[0].toLowerCase() === 'media'
  );

  if (metadata) {
    ['title', 'summary', 'program', 'discipline', 'year'].forEach(field => {
      if (metadata[field] === undefined || metadata[field] === null || String(metadata[field]).trim() === '') {
        errors.push(`missing ${field}`);
      }
    });

    if (!metadata.supervisor || String(metadata.supervisor).trim() === '') {
      warnings.push('missing supervisor');
    }
  }

  if (!posterImage) errors.push('missing poster image');
  if (!posterPdf) errors.push('missing poster.pdf');
  if (!accessibilityFile) warnings.push('missing accessibility.txt');
  if (snapshotFiles.length === 0) warnings.push('missing snapshots folder');
  if (entries.some(entry => entry.file.size > IMPORT_FILE_WARNING_SIZE)) {
    warnings.push('oversized files if a max limit is defined');
  }

  const allowedTemplateIds = ['poster_showcase', 'technical_detail', 'media_rich'];
  let templateId = metadata?.templateId || 'poster_showcase';
  if (!allowedTemplateIds.includes(templateId)) {
    warnings.push('unknown templateId fallback');
    templateId = 'poster_showcase';
  }

  const allowedFeaturedMedia = ['auto', 'poster', 'video', 'gallery', 'snapshots', 'none'];
  let featuredMedia = metadata?.featuredMedia || 'poster';
  if (!allowedFeaturedMedia.includes(featuredMedia)) {
    warnings.push('unknown featuredMedia fallback');
    featuredMedia = 'poster';
  }

  if (mediaFiles.some(entry => !SUPPORTED_IMPORT_MEDIA.has(entry.parts[1].toLowerCase()))) {
    warnings.push('unsupported optional media type');
  }

  return {
    metadata,
    errors,
    warnings,
    templateId,
    featuredMedia,
    files: {
      posterImage,
      posterPdf,
      accessibilityFile,
      snapshotFiles,
      mediaFiles,
      videoFile: mediaFiles.find(entry => entry.parts[1].toLowerCase() === 'demo-video.mp4'),
      audioFile: mediaFiles.find(entry => entry.parts[1].toLowerCase() === 'audio.mp3'),
      modelFile: mediaFiles.find(entry => ['model.glb', 'model.gltf'].includes(entry.parts[1].toLowerCase()))
    }
  };
};

const uploadImportAsset = async (batchId, projectSlug, targetPath, entry) => {
  const parts = targetPath.split('/');
  const filename = sanitizeFileName(parts.pop());
  const dir = parts.length > 0 ? `${parts.join('/')}/` : '';
  const storagePath = `imports/${batchId}/${projectSlug}/${dir}${filename}`;
  return projectStore.uploadProjectAsset(storagePath, entry.file.buffer, contentTypeForFile(filename));
};

const uploadPreparedAssets = async (batchId, projectSlug, prepared) => {
  const posterExt = path.extname(prepared.files.posterImage.parts[0]).toLowerCase();
  const poster = await uploadImportAsset(batchId, projectSlug, `poster${posterExt}`, prepared.files.posterImage);
  const posterPdf = await uploadImportAsset(batchId, projectSlug, 'poster.pdf', prepared.files.posterPdf);
  const accessibilityText = prepared.files.accessibilityFile
    ? prepared.files.accessibilityFile.file.buffer.toString('utf8')
    : '';

  if (prepared.files.accessibilityFile) {
    await uploadImportAsset(batchId, projectSlug, 'accessibility.txt', prepared.files.accessibilityFile);
  }

  const snapshots = [];
  for (const snapshotFile of prepared.files.snapshotFiles) {
    const filename = sanitizeFileName(snapshotFile.parts[1]);
    snapshots.push(await uploadImportAsset(batchId, projectSlug, `snapshots/${filename}`, snapshotFile));
  }

  const media = {};
  for (const mediaFile of prepared.files.mediaFiles) {
    const filename = sanitizeFileName(mediaFile.parts[1]);
    if (!SUPPORTED_IMPORT_MEDIA.has(filename.toLowerCase())) continue;
    const url = await uploadImportAsset(batchId, projectSlug, `media/${filename}`, mediaFile);
    media[filename.toLowerCase()] = url;
  }

  return { poster, posterPdf, accessibilityText, snapshots, media };
};

const buildImportedProjectRecord = (id, batchId, projectFolder, prepared, uploadedAssets) => {
  const metadata = prepared.metadata;
  const status = prepared.warnings.length > 0 ? 'warning' : 'valid';
  const students = Array.isArray(metadata.students) ? metadata.students : [];
  const externalLinks = Array.isArray(metadata.externalLinks) ? metadata.externalLinks : [];
  const uploadedVideoUrl = uploadedAssets.media['demo-video.mp4'];

  return {
    id,
    title: metadata.title || '',
    summary: metadata.summary || '',
    background: metadata.background || '',
    solution: metadata.solution || '',
    year: String(metadata.year || ''),
    program: metadata.program || '',
    studyProgram: metadata.program || '',
    discipline: metadata.discipline || '',
    disciplines: metadata.discipline ? [metadata.discipline] : [],
    industry: metadata.industry || '',
    supervisor: metadata.supervisor || '',
    academicSupervisor: metadata.supervisor || '',
    industryPartner: metadata.industryPartner || '',
    groupName: metadata.groupName || '',
    students,
    teamMembers: students,
    poster: uploadedAssets.poster,
    posterPdf: uploadedAssets.posterPdf,
    snapshots: uploadedAssets.snapshots,
    videoUrl: uploadedVideoUrl || metadata.videoUrl || '',
    demoUrl: metadata.demoUrl || '',
    repositoryUrl: metadata.repositoryUrl || '',
    accessibilityText: uploadedAssets.accessibilityText,
    externalLinks,
    layoutConfig: {
      templateId: prepared.templateId,
      featuredMedia: prepared.featuredMedia,
      sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
      hiddenSections: []
    },
    status: 'in_review',
    importBatchId: batchId,
    sourceFolder: projectFolder.folder,
    packageValidation: {
      status,
      errors: prepared.errors,
      warnings: prepared.warnings,
      assets: {
        poster: true,
        posterPdf: true,
        snapshots: uploadedAssets.snapshots.length,
        media: uploadedAssets.media
      }
    },
    validationFlags: {
      hasErrors: false,
      hasWarnings: prepared.warnings.length > 0,
      missingAccessibility: prepared.warnings.includes('missing accessibility.txt'),
      missingSnapshots: prepared.warnings.includes('missing snapshots folder'),
      hasVideo: !!uploadedAssets.media['demo-video.mp4'],
      hasAudio: !!uploadedAssets.media['audio.mp3'],
      hasModel3d: !!(uploadedAssets.media['model.glb'] || uploadedAssets.media['model.gltf'])
    },
    lastUpdated: new Date().toISOString()
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 250,
    fields: 20
  }
});
const IMPORT_FILE_WARNING_SIZE = 50 * 1024 * 1024;
const SUPPORTED_IMPORT_MEDIA = new Set(['demo-video.mp4', 'audio.mp3', 'model.glb', 'model.gltf']);

// Persistent Path Configuration
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_FEED_DIR = process.env.PUBLIC_FEED_DIR || path.join(__dirname, 'public');

const DB_PATH = path.join(DATA_DIR, 'db.json');
const FEED_PATH = path.join(PUBLIC_FEED_DIR, 'capstones-latest.json');
const SAFE_DELETE_STATUSES = new Set(['draft', 'submitted', 'in_review', 'archived']);
const BULK_APPROVE_STATUSES = new Set(['draft', 'submitted', 'in_review']);

const getProjectStatus = (project) => String(project?.status || '').toLowerCase();

const hasImportMarker = (project) => Boolean(project?.importBatchId || project?.sourceFolder);

const hasPublishedMarker = (project) => Boolean(
  project?.lastPublishedAt ||
  project?.lastPublishedPublicHash ||
  project?.publishedAt
);

const readPublicFeedProjects = () => {
  if (!fs.existsSync(FEED_PATH)) return [];
  const feed = JSON.parse(fs.readFileSync(FEED_PATH, 'utf8'));
  return Array.isArray(feed) ? feed : [];
};

const isProjectInPublicFeed = (projectId) => {
  return readPublicFeedProjects().some(project => String(project.id) === String(projectId));
};

const getSafeDeleteBlocker = (project, projectId) => {
  const status = getProjectStatus(project);

  if (!hasImportMarker(project)) {
    return 'Hard delete is only allowed for imported CMS review records.';
  }

  if (!SAFE_DELETE_STATUSES.has(status)) {
    return 'Hard delete is only allowed for draft, submitted, in_review, or archived records.';
  }

  if (status === 'approved' || status === 'published') {
    return 'Approved or published records cannot be hard-deleted.';
  }

  if (hasPublishedMarker(project)) {
    return 'Records with Duda publish history cannot be hard-deleted.';
  }

  if (isProjectInPublicFeed(projectId)) {
    return 'Records present in the public feed cannot be hard-deleted.';
  }

  return null;
};

const hasTextValue = (value) => String(value || '').trim() !== '';

const hasBlockingValidationFlag = (value) => {
  if (!value) return false;
  if (Array.isArray(value)) {
    return value.some(item => hasBlockingValidationFlag(item));
  }
  if (typeof value === 'object') {
    if (value.hasErrors === true) return true;
    const severity = String(value.severity || value.level || value.type || value.status || '').toLowerCase();
    if (['error', 'blocking', 'blocker', 'critical'].includes(severity)) return true;
    return Object.values(value).some(item => hasBlockingValidationFlag(item));
  }
  return false;
};

const getBulkApproveBlockers = (project) => {
  const blockers = [];
  const status = getProjectStatus(project);
  const packageStatus = String(project?.packageValidation?.status || '').toLowerCase();
  const packageErrors = Array.isArray(project?.packageValidation?.errors)
    ? project.packageValidation.errors
    : [];
  const validationErrors = Array.isArray(project?.validationErrors)
    ? project.validationErrors
    : [];

  if (!BULK_APPROVE_STATUSES.has(status)) {
    blockers.push('Status must be draft, submitted, or in_review.');
  }
  if (status === 'published') {
    blockers.push('Published records cannot be bulk-approved.');
  }
  if (status === 'archived') {
    blockers.push('Archived records cannot be bulk-approved.');
  }
  if (packageStatus === 'error') {
    blockers.push('Package validation status is error.');
  }
  if (packageErrors.length > 0) {
    blockers.push(`Package validation has ${packageErrors.length} blocking error${packageErrors.length === 1 ? '' : 's'}.`);
  }
  if (validationErrors.length > 0) {
    blockers.push(`Project validation has ${validationErrors.length} blocking error${validationErrors.length === 1 ? '' : 's'}.`);
  }
  if (hasBlockingValidationFlag(project?.validationFlags)) {
    blockers.push('Validation flags contain blocking or error severity items.');
  }

  ['title', 'summary', 'program', 'discipline', 'year'].forEach(field => {
    if (!hasTextValue(project?.[field])) {
      blockers.push(`Missing required public field: ${field}.`);
    }
  });

  if (project?.packageValidation?.assets) {
    if (!hasTextValue(project.poster)) {
      blockers.push('Missing poster image required by package validation.');
    }
    if (!hasTextValue(project.posterPdf)) {
      blockers.push('Missing poster PDF required by package validation.');
    }
  } else if (!hasTextValue(project?.poster) && !hasTextValue(project?.posterPdf)) {
    blockers.push('Missing public poster asset.');
  }

  return blockers;
};

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  console.log(`Creating DATA_DIR: ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(PUBLIC_FEED_DIR)) {
  console.log(`Creating PUBLIC_FEED_DIR: ${PUBLIC_FEED_DIR}`);
  fs.mkdirSync(PUBLIC_FEED_DIR, { recursive: true });
}

// Seed db.json if missing from DATA_DIR
const LOCAL_SEED_DB = path.join(__dirname, 'data', 'db.json');
if (!fs.existsSync(DB_PATH) && fs.existsSync(LOCAL_SEED_DB)) {
  console.log(`Seeding db.json from local template to: ${DB_PATH}`);
  fs.copyFileSync(LOCAL_SEED_DB, DB_PATH);
}

// Seed Supabase if empty on startup
const seedIfNecessary = async () => {
  try {
    const localData = [];
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      localData.push(...JSON.parse(data));
    } else if (fs.existsSync(LOCAL_SEED_DB)) {
      const data = fs.readFileSync(LOCAL_SEED_DB, 'utf8');
      localData.push(...JSON.parse(data));
    }
    
    if (localData.length > 0) {
      await projectStore.seedProjectsIfEmpty(localData);
    }
  } catch (err) {
    console.warn('Seeding check failed (this is normal if DB is already set up):', err.message);
  }
};
seedIfNecessary();

/**
 * REUSABLE HELPER: Generate the local public feed
 * This strips internal fields and only includes approved/published records.
 */
const generatePublicFeed = async () => {
  const projects = await projectStore.getProjects();
  
  // Rule: Only Approved or Published records go to the public showcase
  const publicProjects = projects
    .filter(p => p.status === 'approved' || p.status === 'published')
    .map(({ 
      status, 
      internalNotes, 
      reviewNotes, 
      missingItems, 
      previewUrl, 
      previewSentAt, 
      studentConfirmedAt, 
      publishedAt, 
      archivedAt, 
      archiveReason,
      validationFlags, 
      ocrStatus, 
      adminId, 
      validationErrors, 
      validationWarnings, 
      staffNotes, 
      privateNotes, 
      lastUpdated, 
      importBatchId,
      sourceFolder,
      sampleImportId,
      packageValidation,
      pendingRemovalFromPublic,
      archivedFromStatus,
      // Ensure we don't accidentally include new internal fields
      ...publicFields 
    }) => publicFields);

  fs.writeFileSync(FEED_PATH, JSON.stringify(publicProjects, null, 2));

  const archivedCount = projects.filter(p => p.status === 'archived').length;
  const excludedStatuses = projects
    .filter(p => p.status !== 'approved' && p.status !== 'published')
    .reduce((acc, p) => {
      acc[p.status] = (acc[p.status] || 0) + 1;
      return acc;
    }, {});

  return {
    count: publicProjects.length,
    archivedCount,
    excludedCount: projects.length - publicProjects.length,
    excludedStatuses,
    includedProjects: projects
      .filter(p => p.status === 'approved' || p.status === 'published')
      .map(p => ({ title: p.title, status: p.status })),
    excludedArchived: projects
      .filter(p => p.status === 'archived')
      .map(p => p.title),
    path: '/capstones-latest.json',
    timestamp: new Date().toISOString()
  };
};

app.use(cors());
app.use(express.json());

// Middleware: Simple Admin Access Protection (Optional)
const adminAuth = (req, res, next) => {
  const adminKey = process.env.ADMIN_ACCESS_KEY;
  // If no key is configured in environment, allow all (for local dev convenience)
  if (!adminKey) return next();
  
  const clientKey = req.headers['x-admin-key'];
  if (clientKey === adminKey) return next();
  
  res.status(401).json({ error: 'Unauthorized: Admin Access Key required.' });
};

// 1. Static Assets (Public and Build)
app.use(express.static('public'));
if (process.env.PUBLIC_FEED_DIR) {
  app.use(express.static(process.env.PUBLIC_FEED_DIR));
}
app.use(express.static(path.join(__dirname, 'dist')));

// Public: Download Excel template
app.get('/api/download-template', (req, res) => {
  try {
    const headers = [
      'Project title', 'Short public summary', 'Project background', 'Solution / impact',
      'Team members', 'Group name', 'Academic supervisor', 'Industry partner',
      'Industry sector', 'Study program', 'Primary discipline', 'Project year',
      'Showcase layout', 'Main media to feature', 'Accessibility text'
    ];
    const exampleRow = [
      'Smart Campus Navigation Assistant',
      'An interactive 3D navigation assistant for RMIT campus visitors.',
      'RMIT campus can be complex for new visitors to navigate.',
      'Developed a WebGL-based mobile-friendly interactive 3D campus navigation application.',
      'John Doe, Jane Smith',
      'Group A',
      'Dr. Supervisor Name',
      'RMIT Property Services',
      'Technology',
      'Bachelor of Software Engineering',
      'Software Engineering',
      '2026',
      'Media-rich showcase',
      'Video',
      '3D campus model showing Building 10 with interactive path lines.'
    ];
    const optionsRows = [
      ['Field', 'Allowed values', 'Notes'],
      ['Showcase layout', 'Poster showcase', 'Poster-first public showcase for standard poster projects.'],
      ['Showcase layout', 'Technical report', 'Report-first layout for text-heavy technical projects.'],
      ['Showcase layout', 'Media-rich showcase', 'Video or gallery-led showcase for richer media packages.'],
      ['Main media to feature', 'Auto', 'Let the system choose the best available media.'],
      ['Main media to feature', 'Poster', 'Feature the poster image first.'],
      ['Main media to feature', 'Gallery', 'Feature project snapshots first.'],
      ['Main media to feature', 'Video', 'Feature the project video first when supplied.']
    ];

    const ws = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Project Details');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(optionsRows), 'Options');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=project-details.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate Excel template: ' + err.message });
  }
});

// Read-only projects list
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await projectStore.getProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Protected: Import one project folder or a parent folder containing multiple projects
app.post('/api/import-folder', adminAuth, (req, res) => {
  importUpload.array('files')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const message = uploadErr instanceof multer.MulterError
        ? `Upload rejected: ${uploadErr.code}`
        : 'Upload rejected.';
      return res.status(400).json({ error: message });
    }

    try {
      const files = Array.isArray(req.files) ? req.files : [];
      const mode = req.body.mode === 'batch' ? 'batch' : 'single';
      if (files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
      }

      const batchId = `import-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const rawEntries = buildImportEntries(files, req.body);
      if (rawEntries.length === 0) {
        return res.status(400).json({ error: 'No importable files uploaded.' });
      }

      const { commonRoot, entries } = stripCommonRoot(rawEntries);
      const projectFolders = groupProjectFolders(entries, mode, commonRoot);
      if (projectFolders.length === 0) {
        return res.status(400).json({ error: 'No project folders detected.' });
      }

      const projects = [];
      let importedCount = 0;
      let warningCount = 0;
      let errorCount = 0;

      for (const projectFolder of projectFolders) {
        const prepared = validateAndPrepareProject(projectFolder);
        const status = prepared.errors.length > 0
          ? 'error'
          : prepared.warnings.length > 0
            ? 'warning'
            : 'valid';
        const assets = {
          poster: !!prepared.files.posterImage,
          posterPdf: !!prepared.files.posterPdf,
          snapshots: prepared.files.snapshotFiles.length,
          video: !!prepared.files.videoFile,
          audio: !!prepared.files.audioFile,
          model3d: !!prepared.files.modelFile
        };

        if (status === 'error') {
          errorCount++;
          projects.push({
            id: null,
            folder: projectFolder.folder,
            title: prepared.metadata?.title || '',
            status,
            imported: false,
            errors: prepared.errors,
            warnings: prepared.warnings,
            assets
          });
          continue;
        }

        try {
          const projectSlug = projectFolder.slug;
          const id = deterministicProjectId(prepared.metadata.year, projectSlug);
          const uploadedAssets = await uploadPreparedAssets(batchId, projectSlug, prepared);
          const projectRecord = buildImportedProjectRecord(id, batchId, projectFolder, prepared, uploadedAssets);
          await projectStore.upsertProject(projectRecord);

          importedCount++;
          if (status === 'warning') warningCount++;

          projects.push({
            id,
            folder: projectFolder.folder,
            title: prepared.metadata.title || '',
            status,
            imported: true,
            errors: [],
            warnings: prepared.warnings,
            assets
          });
        } catch (err) {
          errorCount++;
          projects.push({
            id: null,
            folder: projectFolder.folder,
            title: prepared.metadata?.title || '',
            status: 'error',
            imported: false,
            errors: [`storage/database import failed: ${err.message}`],
            warnings: prepared.warnings,
            assets
          });
        }
      }

      res.json({
        batchId,
        mode,
        importedCount,
        warningCount,
        errorCount,
        projects
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
});

// Read-only single project
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await projectStore.getProjectById(parseInt(req.params.id));
    if (project) res.json(project);
    else res.status(404).send('Project not found');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Protected: Create project
app.post('/api/projects', adminAuth, async (req, res) => {
  try {
    const newProject = {
      ...req.body,
      id: req.body.id || Date.now(),
      status: req.body.status || 'submitted',
      lastUpdated: new Date().toISOString()
    };
    const created = await projectStore.createProject(newProject);
    await generatePublicFeed();
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Protected: Bulk approve eligible CMS review records only
app.post('/api/projects/bulk-approve', adminAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.map(id => Number(id)).filter(Number.isInteger))]
    : [];

  if (ids.length === 0) {
    return res.status(400).json({ error: 'Request body must include an ids array.' });
  }

  try {
    const results = [];

    for (const id of ids) {
      const project = await projectStore.getProjectById(id);

      if (!project) {
        results.push({
          id,
          title: '',
          action: 'skipped',
          reason: 'Project not found.'
        });
        continue;
      }

      const blockers = getBulkApproveBlockers(project);
      if (blockers.length > 0) {
        results.push({
          id,
          title: project.title || '',
          action: 'skipped',
          reason: blockers.join(' ')
        });
        continue;
      }

      const updated = await projectStore.updateProject(id, { status: 'approved' });
      results.push({
        id,
        title: updated.title || project.title || '',
        action: 'approved'
      });
    }

    const approvedCount = results.filter(result => result.action === 'approved').length;
    const skippedCount = results.length - approvedCount;

    res.json({
      success: true,
      approvedCount,
      skippedCount,
      results,
      message: `Approved ${approvedCount} CMS review record${approvedCount === 1 ? '' : 's'}. Skipped ${skippedCount}. This does not publish to Duda.`
    });
  } catch (err) {
    console.error('Error in POST /api/projects/bulk-approve:', err);
    res.status(500).json({ error: err.message });
  }
});

// Protected: Archive public workflow record without publishing or deleting assets
app.post('/api/projects/:id/archive', adminAuth, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID.' });
  }

  try {
    const project = await projectStore.getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const status = getProjectStatus(project);
    if (status === 'archived') {
      return res.json({
        success: true,
        project,
        message: 'Project is already archived.'
      });
    }

    if (!['approved', 'published', 'draft', 'submitted', 'in_review'].includes(status)) {
      return res.status(400).json({ error: 'Project status is not eligible for archive workflow.' });
    }

    const wasPublicWorkflow = status === 'approved' || status === 'published' || isProjectInPublicFeed(projectId) || hasPublishedMarker(project);
    const archived = await projectStore.updateProject(projectId, {
      status: 'archived',
      archivedAt: new Date().toISOString(),
      archivedFromStatus: project.status || '',
      archiveReason: req.body?.reason || 'Archived from CMS workflow',
      pendingRemovalFromPublic: wasPublicWorkflow
    });

    res.json({
      success: true,
      project: archived,
      message: wasPublicWorkflow
        ? 'Project archived and marked for removal from the public showcase on the next Duda publish.'
        : 'Project archived.'
    });
  } catch (err) {
    console.error('Error in POST /api/projects/:id/archive:', err);
    res.status(500).json({ error: err.message });
  }
});

// Protected: Update project
app.put('/api/projects/:id', adminAuth, async (req, res) => {
  console.log(`PUT /api/projects/${req.params.id}`, req.body);
  try {
    const updated = await projectStore.updateProject(parseInt(req.params.id), req.body);
    await generatePublicFeed();
    res.json(updated);
  } catch (err) {
    console.error('Error in PUT /api/projects:', err);
    res.status(500).json({ error: err.message });
  }
});

// Protected: Safe Delete imported review project record
app.delete('/api/projects/:id', adminAuth, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID.' });
  }

  console.log(`DELETE /api/projects/${projectId} safe delete request`);
  try {
    const project = await projectStore.getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const blocker = getSafeDeleteBlocker(project, projectId);
    if (blocker) {
      return res.status(403).json({ error: `Safety violation: ${blocker}` });
    }

    const deletion = await projectStore.deleteProject(projectId);
    if (!deletion.success) {
      return res.status(404).json({ error: 'Project was not deleted because it no longer exists.' });
    }

    console.log(`SUCCESS: Safely hard-deleted imported review record ${projectId}`);

    res.json({
      success: true,
      deletedId: projectId,
      message: 'Safely removed the imported CMS review record only.'
    });
  } catch (err) {
    console.error('Error in DELETE /api/projects:', err);
    res.status(500).json({ error: err.message });
  }
});


// Protected: Generate local public feed
app.post('/api/generate-feed', adminAuth, async (req, res) => {
  try {
    const result = await generatePublicFeed();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Protected: Publish to cloud stable URL
app.post('/api/publish-cloud-feed', adminAuth, async (req, res) => {
  try {
    // Ensure local feed is up to date first
    const generationResult = await generatePublicFeed();

    // Publish to cloud
    const cloudResult = await publishToCloud(FEED_PATH);
    
    if (cloudResult.success) {
      // SUCCESS: Transition all approved records to published and stamp metadata
      const projects = await projectStore.getProjects();
      let updatedCount = 0;
      
      for (const p of projects) {
        if (p.status === 'approved' || p.status === 'published') {
          const updatePayload = {
            lastPublishedPublicHash: getPublicPayloadHash(p),
            lastPublishedTemplateId: (p.layoutConfig && p.layoutConfig.templateId) || 'poster_showcase',
            lastPublishedAt: new Date().toISOString()
          };
          if (p.status === 'approved') {
            updatedCount++;
            updatePayload.status = 'published';
            updatePayload.publishedAt = updatePayload.lastPublishedAt;
          }
          await projectStore.updateProject(p.id, updatePayload);
        }
      }

      // Regenerate local feed to ensure timestamps/status consistency
      await generatePublicFeed();

      res.json({
        ...cloudResult,
        ...generationResult,
        updatedCount,
        message: `Successfully synced ${generationResult.count} records to the official showcase. ${updatedCount} approved records transitioned to Published. Excluded ${generationResult.archivedCount} archived records.`
      });
    } else {
      res.status(500).json(cloudResult);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Get feed status (local + cloud URL)
app.get('/api/feed-status', (req, res) => {
  if (fs.existsSync(FEED_PATH)) {
    const stats = fs.statSync(FEED_PATH);
    const content = JSON.parse(fs.readFileSync(FEED_PATH, 'utf8'));
    
    // Construct cloud URL safely
    let cloudUrl = null;
    const sBase = process.env.SUPABASE_URL;
    const sBucket = process.env.SUPABASE_FEED_BUCKET || 'feeds';
    const sFile = process.env.SUPABASE_FEED_FILE || 'capstones-latest.json';

    if (sBase && sBase.startsWith('http')) {
      // Format: https://[ref].supabase.co/storage/v1/object/public/[bucket]/[file]
      cloudUrl = `${sBase.replace(/\/$/, '')}/storage/v1/object/public/${sBucket}/${sFile}`;
    }

    res.json({
      exists: true,
      count: content.length,
      lastUpdated: stats.mtime,
      cloudUrl: cloudUrl
    });
  } else {
    res.json({ exists: false });
  }
});

// 8. Get published cloud feed status (Supabase stable URL count)
app.get('/api/published-feed-status', async (req, res) => {
  try {
    const status = await getPublishedFeedStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ exists: false, error: err.message });
  }
});


// Wildcard SPA Fallback (Must be LAST)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`Admin API server running on port ${PORT}`);
  // Generate local feed on startup
  try {
    await generatePublicFeed();
  } catch (err) {
    console.warn('Initial feed generation skipped (DB not ready?):', err.message);
  }
});
