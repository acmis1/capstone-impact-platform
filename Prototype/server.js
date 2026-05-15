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
  
  const publicProjects = projects
    .filter(p => p.status === 'approved' || p.status === 'published')
    .map(({ 
      status, internalNotes, lastUpdated, adminId, 
      validationErrors, validationWarnings, staffNotes, privateNotes, 
      ...publicFields 
    }) => publicFields);

  fs.writeFileSync(FEED_PATH, JSON.stringify(publicProjects, null, 2));

  return {
    count: publicProjects.length,
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
    status: 'draft',
    lastUpdated: new Date().toISOString()
  };
  projects.push(newProject);
  writeDB(projects);
  res.status(201).json(newProject);
});

// 4. Update project
app.put('/api/projects/:id', (req, res) => {
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
    res.status(404).send('Project not found');
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
      res.json({
        ...cloudResult,
        count: generationResult.count
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
});
