import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { publishToCloud } from './utils/supabasePublisher.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 5000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const FEED_PATH = path.join(__dirname, 'public', 'capstones-latest.json');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper to read DB
const readDB = () => {
  if (!fs.existsSync(DB_PATH)) return [];
  const data = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(data);
};

// Helper to write DB
const writeDB = (data) => {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
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

// API Routes

// 1. List all projects
app.get('/api/projects', (req, res) => {
  res.json(readDB());
});

// 2. Get single project
app.get('/api/projects/:id', (req, res) => {
  const projects = readDB();
  const project = projects.find(p => p.id === parseInt(req.params.id));
  if (project) res.json(project);
  else res.status(404).send('Project not found');
});

// 3. Create project
app.post('/api/projects', (req, res) => {
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

// 4. Update project
app.put('/api/projects/:id', (req, res) => {
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


// 5. Generate local public feed
app.post('/api/generate-feed', (req, res) => {
  try {
    const result = generatePublicFeed();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Publish to cloud stable URL
app.post('/api/publish-cloud-feed', async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Admin API server running at http://localhost:${PORT}`);
  // Generate local feed on startup
  generatePublicFeed();
});
