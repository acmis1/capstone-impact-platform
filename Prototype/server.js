import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { publishToCloud, getPublishedFeedStatus } from './utils/supabasePublisher.js';
import * as projectStore from './utils/projectStore.js';

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

const groupProjectFolders = (entries, mode, commonRoot) => {
  const rootProjectJson = entries.some(entry =>
    entry.parts.length === 1 && entry.parts[0].toLowerCase() === 'project.json'
  );

  if (mode === 'single') {
    if (rootProjectJson) {
      return [{ folder: commonRoot || 'project', slug: normalizeSlug(commonRoot || 'project'), entries }];
    }

    const folderNames = new Set(entries.map(entry => entry.parts[0]).filter(Boolean));
    const projectFolders = [...folderNames].filter(folder =>
      entries.some(entry =>
        entry.parts[0] === folder &&
        entry.parts.length === 2 &&
        entry.parts[1].toLowerCase() === 'project.json'
      )
    );

    if (projectFolders.length !== 1) {
      throw new Error('Single import mode requires one project folder with project.json.');
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

const validateAndPrepareProject = (projectFolder) => {
  const errors = [];
  const warnings = [];
  const entries = projectFolder.entries;
  const projectJsonFile = findProjectFile(entries, 'project.json');
  let metadata = null;

  if (!projectJsonFile) {
    errors.push('missing project.json');
  } else {
    try {
      metadata = JSON.parse(projectJsonFile.file.buffer.toString('utf8'));
    } catch {
      errors.push('invalid JSON');
    }
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

  const allowedFeaturedMedia = ['poster', 'video', 'snapshots', 'none'];
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

// API Routes

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
