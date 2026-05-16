import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { publishToCloud } from './utils/supabasePublisher.js';
import { backupAdminState, restoreAdminState, getAdminStateBackupStatus } from './utils/adminStateBackup.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

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

// ---------------------------------------------------------
// Startup Restore: Try to recover state from cloud if on Render/Staging
// ---------------------------------------------------------
const initRestore = async () => {
  if (process.env.ENABLE_ADMIN_STATE_BACKUP === 'true') {
    console.log('Admin state backup enabled. Attempting to restore from cloud...');
    const result = await restoreAdminState(DB_PATH);
    if (result.success) {
      console.log(`Successfully restored admin state from cloud. Records: ${result.recordCount}`);
      // Regenerate feed from restored data
      generatePublicFeed();
    } else {
      console.warn(`Cloud restore skipped or failed: ${result.error}. Falling back to local disk.`);
    }
  }
};
initRestore();

// Helper to read DB
const readDB = () => {
  if (!fs.existsSync(DB_PATH)) return [];
  const data = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(data);
};

// Helper to write DB
const writeDB = (data) => {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  
  // Background backup (Do not block)
  if (process.env.ENABLE_ADMIN_STATE_BACKUP === 'true') {
    backupAdminState(DB_PATH).then(res => {
      if (!res.success) console.warn('Saved locally, but cloud backup failed:', res.error);
    });
  }
};

/**
 * REUSABLE HELPER: Generate the local public feed
 * This strips internal fields and only includes approved/published records.
 */
const generatePublicFeed = () => {
  const projects = readDB();
  
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
app.get('/api/projects', (req, res) => {
  res.json(readDB());
});

// Read-only single project
app.get('/api/projects/:id', (req, res) => {
  const projects = readDB();
  const project = projects.find(p => p.id === parseInt(req.params.id));
  if (project) res.json(project);
  else res.status(404).send('Project not found');
});

// Protected: Create project
app.post('/api/projects', adminAuth, (req, res) => {
  const projects = readDB();
  const newProject = {
    ...req.body,
    id: Date.now(),
    status: 'submitted',
    lastUpdated: new Date().toISOString()
  };
  projects.push(newProject);
  writeDB(projects);
  res.status(201).json(newProject);
});

// Protected: Update project
app.put('/api/projects/:id', adminAuth, (req, res) => {
  console.log(`PUT /api/projects/${req.params.id}`, req.body);
  try {
    const projects = readDB();
    const index = projects.findIndex(p => p.id === parseInt(req.params.id));
    if (index !== -1) {
      projects[index] = { 
        ...projects[index], 
        ...req.body, 
        lastUpdated: new Date().toISOString() 
      };
      writeDB(projects);
      res.json(projects[index]);
    } else {
      res.status(404).json({ error: 'Project not found' });
    }
  } catch (err) {
    console.error('Error in PUT /api/projects:', err);
    res.status(500).json({ error: err.message });
  }
});


// Protected: Generate local public feed
app.post('/api/generate-feed', adminAuth, (req, res) => {
  try {
    const result = generatePublicFeed();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Protected: Publish to cloud stable URL
app.post('/api/publish-cloud-feed', adminAuth, async (req, res) => {
  try {
    // Ensure local feed is up to date first
    const generationResult = generatePublicFeed();

    // Publish to cloud
    const cloudResult = await publishToCloud(FEED_PATH);
    
    if (cloudResult.success) {
      // SUCCESS: Transition all approved records to published
      const projects = readDB();
      let updatedCount = 0;
      
      const updatedProjects = projects.map(p => {
        if (p.status === 'approved') {
          updatedCount++;
          return {
            ...p,
            status: 'published',
            publishedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
          };
        }
        return p;
      });

      if (updatedCount > 0) {
        writeDB(updatedProjects);
        // Regenerate local feed to ensure timestamps/status consistency (even if status is stripped)
        generatePublicFeed();
      }

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

// 8. Admin State Backup Management
app.get('/api/admin-state/status', async (req, res) => {
  try {
    const status = await getAdminStateBackupStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin-state/backup', adminAuth, async (req, res) => {
  try {
    const result = await backupAdminState(DB_PATH);
    if (result.success) {
      res.json({ success: true, message: 'Admin state backed up successfully.', ...result });
    } else {
      res.status(500).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin-state/restore', adminAuth, async (req, res) => {
  try {
    const result = await restoreAdminState(DB_PATH);
    if (result.success) {
      // Regenerate local feed after restore
      const feedResult = generatePublicFeed();
      res.json({ 
        success: true, 
        message: 'Admin state restored successfully.', 
        ...result,
        feed: feedResult 
      });
    } else {
      res.status(500).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Wildcard SPA Fallback (Must be LAST)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Admin API server running on port ${PORT}`);
  // Generate local feed on startup
  generatePublicFeed();
});

