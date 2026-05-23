import React, { useState, useEffect } from 'react';
import './styles.css';

const API_URL = '/api';

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

const getDudaSyncStatus = (project) => {
  if (!project) return { label: 'Not public', code: 'not_public' };

  const status = project.status;
  const currentHash = getPublicPayloadHash(project);
  const lastHash = project.lastPublishedPublicHash;
  const wasPreviouslyPublished = !!(project.lastPublishedAt || lastHash);

  if (status === 'published') {
    if (!lastHash) {
      return { label: 'Snapshot not recorded', code: 'unknown' };
    }
    if (lastHash === currentHash) {
      return { label: 'Synced', code: 'synced' };
    }
    return { label: 'Unpublished changes', code: 'unpublished_changes' };
  }

  if (status === 'approved') {
    return { label: 'Pending publish', code: 'pending_publish' };
  }

  if (status === 'archived') {
    if (wasPreviouslyPublished) {
      return { label: 'Pending removal', code: 'pending_removal' };
    }
    return { label: 'Not public', code: 'not_public' };
  }

  return { label: 'Not public', code: 'not_public' };
};

const SIMULATED_PACKAGES = [
  {
    id: 2026101,
    title: "Dynamic Smart Grid Optimization",
    year: "2026",
    program: "Bachelor of Software Engineering",
    studyProgram: "Bachelor of Software Engineering",
    discipline: "Software Engineering",
    disciplines: ["Software Engineering"],
    teamMembers: ["Alex Smith", "Bob Johnson"],
    groupName: "Team Grid",
    academicSupervisor: "Dr. John Doe",
    industry: "Energy",
    industryPartner: "PowerCorp",
    summary: "A decentralized smart grid optimizer using edge telemetry and reinforcement learning.",
    background: "Modern electrical grids struggle with extreme load volatility driven by rapid electric vehicle adoption.",
    solution: "We designed a decentralized smart grid optimizer utilizing edge telemetry and localized reinforcement learning.",
    posterText: "Dynamic Smart Grid Optimization. Edge telemetry. Localized reinforcement learning.",
    citations: ["Smith, A. et al., 2026. Grid Optimization."],
    snapshots: [
      "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/snap1.png"
    ],
    poster: "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/poster1.png",
    posterPdf: "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/poster1.pdf",
    accessibilityText: "Smart Grid Dashboard Preview showing real-time load distribution.",
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    demoUrl: "https://demo.smartgrid-rmit.dev",
    repositoryUrl: "https://github.com/rmit-grid/smart-grid-optimizer",
    externalLinks: [
      { label: "System Architecture", url: "https://docs.smartgrid-rmit.dev/arch" }
    ],
    layoutConfig: {
      templateId: "poster_showcase",
      featuredMedia: "poster",
      sectionOrder: ["background", "solution", "snapshots", "video", "links"],
      hiddenSections: []
    },
    importBatchId: "batch_2026_01",
    sourceFolder: "packages/smart-grid",
    sampleImportId: "sample_grid"
  },
  {
    id: 2026102,
    title: "Autonomous Agriculture Swarm",
    year: "2026",
    program: "Bachelor of Robotics Engineering",
    studyProgram: "Bachelor of Robotics Engineering",
    discipline: "Robotics Engineering",
    disciplines: ["Robotics Engineering", "Software Engineering"],
    teamMembers: ["Charlie Brown", "Diana Prince"],
    groupName: "AgriSwarm",
    academicSupervisor: "Dr. Jane Miller",
    industry: "Agriculture",
    industryPartner: "AgriTech Solutions",
    summary: "A swarm of autonomous drones cooperating to optimize crop irrigation and fertilizer distribution.",
    background: "Water scarcity and chemical overuse are primary challenges in modern precision farming.",
    solution: "We engineered an autonomous robotic swarm capable of dynamic field mapping and variable irrigation.",
    posterText: "Autonomous Agriculture Swarm. Robotic swarm. Precision irrigation.",
    citations: ["Brown, C. et al., 2026. Drone Swarm Control."],
    snapshots: [
      "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/snap2.png"
    ],
    poster: "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/poster2.png",
    posterPdf: "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/poster2.pdf",
    accessibilityText: "Agricultural drone hovering over green fields.",
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    demoUrl: "https://demo.agriswarm.dev",
    repositoryUrl: "https://github.com/rmit-swarm/agri-swarm",
    externalLinks: [],
    layoutConfig: {
      templateId: "technical_detail",
      featuredMedia: "video",
      sectionOrder: ["background", "solution", "snapshots", "video", "links"],
      hiddenSections: []
    },
    importBatchId: "batch_2026_01",
    sourceFolder: "packages/agri-swarm",
    sampleImportId: "sample_swarm"
  },
  {
    id: 2026103,
    title: "Healthcare Telemetry Hub",
    year: "2026",
    program: "Bachelor of Biomedical Science",
    studyProgram: "Bachelor of Biomedical Science",
    discipline: "Biomedical Engineering",
    disciplines: ["Biomedical Engineering"],
    teamMembers: ["Edward Elric", "Flora Rein"],
    groupName: "BioHub",
    academicSupervisor: "Dr. Roy Mustang",
    industry: "Healthcare",
    industryPartner: "RMIT Medical",
    summary: "Real-time wearable telemetry hub for tracking inpatient vitals with low latency.",
    background: "Traditional patient monitoring relies on periodic staff checkins, which can delay emergency responses.",
    solution: "We built a lightweight wearable sensor system that streams vitals with millisecond latency.",
    posterText: "Healthcare Telemetry Hub. Wearable sensor system.",
    citations: ["Elric, E., 2026. Low Latency Wearables."],
    snapshots: [
      "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/snap3.png"
    ],
    poster: "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/poster3.png",
    posterPdf: "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/poster3.pdf",
    accessibilityText: "A small wearable wrist device display.",
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    demoUrl: "https://demo.biohub-rmit.vn",
    repositoryUrl: "https://github.com/rmit-med/biohub-telemetry",
    externalLinks: [],
    layoutConfig: {
      templateId: "media_rich",
      featuredMedia: "snapshots",
      sectionOrder: ["background", "solution", "snapshots", "video", "links"],
      hiddenSections: []
    },
    importBatchId: "batch_2026_01",
    sourceFolder: "packages/health-hub",
    sampleImportId: "sample_health"
  },
  {
    id: 2026104,
    title: "AI Logistics Dispatcher",
    year: "2026",
    program: "Bachelor of Software Engineering",
    studyProgram: "Bachelor of Software Engineering",
    discipline: "Software Engineering",
    disciplines: ["Software Engineering"],
    teamMembers: ["George Costanza", "Helen Seinfeld"],
    groupName: "Vandelay",
    academicSupervisor: "Dr. Cosmo Kramer",
    industry: "Logistics",
    industryPartner: "Vandelay Industries",
    summary: "Dynamic scheduling engine optimized for urban delivery networks.",
    background: "Traffic congestion and inefficient route mapping increase delivery operational costs by 30%.",
    solution: "An intelligent fleet routing coordinator that updates schedules based on live traffic API telemetry.",
    posterText: "AI Logistics Dispatcher. Dynamic route planner.",
    citations: [],
    snapshots: [
      "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/snap4.png"
    ],
    poster: "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/poster4.png",
    posterPdf: "https://xojnnhilqaldxoilmxli.supabase.co/storage/v1/object/public/capstone-impact-demo-assets/poster4.pdf",
    accessibilityText: "", // WARNING: Missing accessibility text
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    demoUrl: "https://demo.vandelay-logistics.com",
    repositoryUrl: "https://github.com/vandelay/ai-dispatcher",
    externalLinks: [],
    files: ["dispatcher.exe", "assets.zip"], // WARNING: Unsupported file formats
    layoutConfig: {
      templateId: "poster_showcase",
      featuredMedia: "poster",
      sectionOrder: ["background", "solution", "snapshots", "video", "links"],
      hiddenSections: []
    },
    importBatchId: "batch_2026_01",
    sourceFolder: "packages/ai-logistics",
    sampleImportId: "sample_logistics"
  },
  {
    id: 2026105,
    title: "Unverified Drone Navigator",
    year: "2026",
    program: "Bachelor of Aviation",
    studyProgram: "Bachelor of Aviation",
    discipline: "Aviation",
    disciplines: ["Aviation"],
    teamMembers: ["Jack Sparrow", "Will Turner"],
    groupName: "BlackPearl",
    academicSupervisor: "Dr. Hector Barbossa",
    industry: "Maritime",
    industryPartner: "East India Co",
    summary: "Dynamic drone routing under heavy oceanic storm systems.",
    background: "Drones lose signal and stability in dense storm centers.",
    solution: "An automated flight path adjuster utilizing barometer feedback.",
    posterText: "Drone storm navigation.",
    citations: [],
    snapshots: [],
    poster: "", // ERROR: Both poster image and PDF missing
    posterPdf: "",
    accessibilityText: "Drone simulator interface.",
    videoUrl: "invalid-url-format-here", // ERROR: Invalid URL format
    demoUrl: "",
    repositoryUrl: "git://github.com/sparrow/drone-storm", // ERROR: Invalid URL format
    externalLinks: [],
    layoutConfig: {
      templateId: "invalid_template_here", // ERROR: Invalid template preset
      featuredMedia: "none",
      sectionOrder: ["background", "solution", "snapshots", "video", "links"],
      hiddenSections: []
    },
    importBatchId: "batch_2026_01",
    sourceFolder: "packages/drone-nav",
    sampleImportId: "sample_drone"
  }
];

const validateProjectPackage = (pkg) => {
  const errors = [];
  const warnings = [];

  // 1. Required Fields Check
  if (!pkg.title || pkg.title.trim() === '') errors.push("Missing project title");
  if (!pkg.year || pkg.year.trim() === '') errors.push("Missing academic year");
  if (!pkg.program || pkg.program.trim() === '') errors.push("Missing academic program");
  if (!pkg.discipline || pkg.discipline.trim() === '') errors.push("Missing discipline");

  // 2. Poster Asset Check (poster OR posterPdf is required)
  if (!pkg.poster && !pkg.posterPdf) {
    errors.push("Missing public poster asset (at least one Poster Image or Poster PDF is required).");
  } else if (!pkg.poster || !pkg.posterPdf) {
    warnings.push(`Only one poster asset provided: ${pkg.poster ? 'Poster Image' : 'Poster PDF'}. Both are preferred but not mandatory.`);
  }

  // 3. Accessibility Text Check
  if (!pkg.accessibilityText || pkg.accessibilityText.trim() === '') {
    warnings.push("Missing accessibility alt text (accessibilityText).");
  }

  // 4. URL Format Check
  const urlPattern = /^(https?:\/\/)[^\s/$.?#].[^\s]*$/i;
  const checkUrl = (url, label) => {
    if (url && !urlPattern.test(url)) {
      errors.push(`Invalid URL format for ${label}: "${url}"`);
    }
  };
  checkUrl(pkg.poster, 'Poster Image URL');
  checkUrl(pkg.posterPdf, 'Poster PDF URL');
  checkUrl(pkg.videoUrl, 'Video URL');
  checkUrl(pkg.demoUrl, 'Demo URL');
  checkUrl(pkg.repositoryUrl, 'Repository URL');

  // 5. Unsupported Files Check
  const unsupportedExtensions = ['.zip', '.exe', '.tar', '.rar', '.dmg', '.msi'];
  if (pkg.files && Array.isArray(pkg.files)) {
    pkg.files.forEach(f => {
      const ext = f.includes('.') ? f.substring(f.lastIndexOf('.')).toLowerCase() : '';
      if (unsupportedExtensions.includes(ext)) {
        warnings.push(`Unsupported file type flagged in package assets: "${f}" (${ext} is not allowed for showcase uploads).`);
      }
    });
  }

  // 6. Layout Preset Check
  const validPresets = ['poster_showcase', 'technical_detail', 'media_rich'];
  if (pkg.layoutConfig && pkg.layoutConfig.templateId) {
    if (!validPresets.includes(pkg.layoutConfig.templateId)) {
      errors.push(`Invalid layout config preset templateId: "${pkg.layoutConfig.templateId}". Must be one of: ${validPresets.join(', ')}`);
    }
  }

  return {
    status: errors.length > 0 ? 'Error' : (warnings.length > 0 ? 'Warning' : 'Valid'),
    errors,
    warnings
  };
};

function App() {
  const [projects, setProjects] = useState([]);
  const [view, setView] = useState('dashboard'); // dashboard, list, edit, public, detail, import
  const [currentProject, setCurrentProject] = useState(null);
  const [previewProject, setPreviewProject] = useState(null);
  const [feedStatus, setFeedStatus] = useState({ exists: false });
  const [publishedStatus, setPublishedStatus] = useState({ exists: false });
  const [cloudStatus, setCloudStatus] = useState(null);
  const [cloudUrl, setCloudUrl] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [adminKey, setAdminKey] = useState(localStorage.getItem('capstone_admin_key') || '');
  const [importPackages, setImportPackages] = useState([]);
  const [realImportMode, setRealImportMode] = useState('single');
  const [realImportFiles, setRealImportFiles] = useState([]);
  const [realImportResult, setRealImportResult] = useState(null);
  const [realImportLoading, setRealImportLoading] = useState(false);
  const [originalProject, setOriginalProject] = useState(null);
  const [expandedSections, setExpandedSections] = useState({
    validation: true,
    content: true,
    media: false,
    layout: true,
    admin: false
  });
  const [cameFromEdit, setCameFromEdit] = useState(false);

  useEffect(() => {
    fetchProjects();
    fetchFeedStatus();
    fetchPublishedStatus();
  }, []);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') setLightboxIndex(-1);
    };

    if (lightboxIndex >= 0) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleEsc);
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleEsc);
    };
  }, [lightboxIndex]);

  const fetchProjects = async () => {
    try {
      const res = await fetch(`${API_URL}/projects`);
      const data = await res.json();
      setProjects(data);
    } catch (err) {
      console.error('Error fetching projects:', err);
    }
  };

  const fetchFeedStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/feed-status`);
      const data = await res.json();
      setFeedStatus(data);
      setCloudUrl(data.cloudUrl);
    } catch (err) {
      console.error('Error fetching feed status:', err);
    }
  };

  const fetchPublishedStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/published-feed-status`);
      const data = await res.json();
      setPublishedStatus(data);
    } catch (err) {
      console.error('Error fetching published feed status:', err);
    }
  };

  const handlePublishCloud = async () => {
    setCloudStatus({ type: 'info', message: 'Syncing to official showcase...' });
    try {
      const res = await fetch(`${API_URL}/publish-cloud-feed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey
        }
      });
      const data = await res.json();
      if (res.ok) {
        const excludedDetail = data.excludedStatuses ?
          Object.entries(data.excludedStatuses).map(([s, c]) => `${c} ${s}`).join(', ') :
          `${data.archivedCount || 0} archived`;

        const diag = `Successfully synced ${data.count} records to the official showcase. (Excluded ${excludedDetail}). ${data.updatedCount || 0} records moved to Published.`;
        alert(diag);
        setCloudStatus({ type: 'success', message: diag });
        setCloudUrl(data.publicUrl);
        fetchProjects();
        fetchFeedStatus();
        fetchPublishedStatus();
      } else {
        setCloudStatus({ type: 'error', message: data.error || 'Official sync failed.' });
      }
    } catch (err) {
      setCloudStatus({ type: 'error', message: 'Network error while syncing.' });
    }
  };

  const handleEdit = (project) => {
    const editProject = {
      ...project,
      disciplines: Array.isArray(project.disciplines) ? project.disciplines.join(', ') : project.disciplines || '',
      teamMembers: Array.isArray(project.teamMembers) ? project.teamMembers.join(', ') : project.teamMembers || '',
      citations: Array.isArray(project.citations) ? project.citations.join(', ') : project.citations || '',
      snapshots: Array.isArray(project.snapshots) ? project.snapshots.join('\n') : project.snapshots || '',
      layoutConfig: project.layoutConfig || {
        templateId: 'poster_showcase',
        featuredMedia: 'poster',
        sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
        hiddenSections: []
      }
    };
    setCurrentProject(editProject);
    setOriginalProject(editProject);
    setExpandedSections({
      validation: true,
      content: true,
      media: false,
      layout: true,
      admin: false
    });
    setView('edit');
  };

  const prepareProjectForSave = (project) => {
    if (!project) return null;
    return {
      ...project,
      disciplines: typeof project.disciplines === 'string' ? project.disciplines.split(',').map(s => s.trim()).filter(s => s !== '') : project.disciplines,
      teamMembers: typeof project.teamMembers === 'string' ? project.teamMembers.split(',').map(s => s.trim()).filter(s => s !== '') : project.teamMembers,
      citations: typeof project.citations === 'string' ? project.citations.split(',').map(s => s.trim()).filter(s => s !== '') : project.citations,
      snapshots: typeof project.snapshots === 'string' ? project.snapshots.split(/[\n,]/).map(s => s.trim()).filter(s => s !== '') : project.snapshots,
    };
  };

  const handleSave = async (e) => {
    if (e) e.preventDefault();
    setLoading(true);

    try {
      const projectToSave = prepareProjectForSave(currentProject);
      if (!projectToSave) throw new Error('No project selected to save');

      const method = projectToSave.id ? 'PUT' : 'POST';
      const url = projectToSave.id ? `${API_URL}/projects/${projectToSave.id}` : `${API_URL}/projects`;

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey
        },
        body: JSON.stringify(projectToSave),
      });

      if (res.ok) {
        const savedProject = await res.json().catch(() => null);
        const sync = getDudaSyncStatus(savedProject);

        if (savedProject && savedProject.status === 'published' && sync.code === 'unpublished_changes') {
          setMessage('Saved CMS changes. Duda is now out of sync until the next Publish to Duda action.');
        } else {
          setMessage('Project saved successfully!');
        }

        fetchProjects();
        fetchFeedStatus();
        fetchPublishedStatus();
        setTimeout(() => {
          setView('list');
          setMessage(null);
        }, 3000);
      } else {
        const errorData = await res.json().catch(() => ({}));
        setMessage(`Error saving project: ${errorData.error || res.statusText}`);
      }
    } catch (err) {
      setMessage(`Error saving project: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadPackages = () => {
    const validated = SIMULATED_PACKAGES.map(pkg => ({
      ...pkg,
      validation: validateProjectPackage(pkg)
    }));
    setImportPackages(validated);
    setMessage("Loaded 5 simulated student packages with validation results.");
    setTimeout(() => setMessage(null), 2000);
  };

  const handleMapValidProjects = async () => {
    setLoading(true);
    let successCount = 0;
    let duplicateCount = 0;

    const compliantPackages = importPackages.filter(pkg => pkg.validation.status !== 'Error');

    for (const pkg of compliantPackages) {
      const isDuplicate = projects.some(p =>
        p.id === pkg.id ||
        p.sourceFolder === pkg.sourceFolder ||
        p.sampleImportId === pkg.sampleImportId
      );

      if (isDuplicate) {
        duplicateCount++;
        continue;
      }

      const newProject = {
        id: pkg.id,
        title: pkg.title,
        year: pkg.year,
        program: pkg.program,
        studyProgram: pkg.program,
        discipline: pkg.discipline,
        disciplines: Array.isArray(pkg.disciplines) ? pkg.disciplines : [pkg.discipline],
        teamMembers: Array.isArray(pkg.teamMembers) ? pkg.teamMembers : pkg.teamMembers.split(',').map(t => t.trim()),
        groupName: pkg.groupName,
        academicSupervisor: pkg.academicSupervisor,
        industry: pkg.industry || 'General',
        industryPartner: pkg.industryPartner,
        summary: pkg.summary,
        background: pkg.background,
        solution: pkg.solution,
        posterText: pkg.posterText || `${pkg.title}. ${pkg.summary}`,
        poster: pkg.poster,
        posterPdf: pkg.posterPdf,
        snapshots: pkg.snapshots,
        accessibilityText: pkg.accessibilityText || '',
        videoUrl: pkg.videoUrl || '',
        demoUrl: pkg.demoUrl || '',
        repositoryUrl: pkg.repositoryUrl || '',
        citations: pkg.citations || [],
        externalLinks: pkg.externalLinks || [],
        layoutConfig: pkg.layoutConfig,
        status: 'in_review',
        importBatchId: pkg.importBatchId,
        sourceFolder: pkg.sourceFolder,
        sampleImportId: pkg.sampleImportId,
        packageValidation: {
          status: pkg.validation.status,
          errors: pkg.validation.errors,
          warnings: pkg.validation.warnings
        }
      };

      try {
        const res = await fetch(`${API_URL}/projects`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': adminKey
          },
          body: JSON.stringify(newProject)
        });

        if (res.ok) {
          successCount++;
        }
      } catch (err) {
        console.error(`Error importing package ${pkg.id}:`, err);
      }
    }

    await fetchProjects();
    setLoading(false);
    setMessage(`Successfully imported ${successCount} projects to CMS in 'In Review' status. (Skipped ${duplicateCount} duplicates).`);
    setTimeout(() => setMessage(null), 3000);
  };

  const countProjectsInBatch = (files) => {
    const folders = new Set();
    files.forEach(f => {
      const parts = f.webkitRelativePath.split('/');
      if (parts.length > 1) {
        folders.add(parts[1]);
      }
    });
    return folders.size;
  };

  const handleFolderSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setRealImportFiles(files);
    setRealImportResult(null);
  };

  const handleRealImport = async () => {
    if (realImportFiles.length === 0) return;
    setRealImportLoading(true);
    setRealImportResult(null);

    try {
      const formData = new FormData();
      formData.append('mode', realImportMode);

      const manifestFiles = [];
      realImportFiles.forEach((file, index) => {
        const uploadName = `file_${index}_${file.name}`;
        formData.append('files', file, uploadName);
        manifestFiles.push({
          uploadName,
          relativePath: file.webkitRelativePath
        });
      });

      formData.append('manifest', JSON.stringify({ files: manifestFiles }));

      const res = await fetch(`${API_URL}/import-folder`, {
        method: 'POST',
        headers: {
          'x-admin-key': adminKey
        },
        body: formData
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || `HTTP error! status: ${res.status}`);
      }

      const result = await res.json();
      setRealImportResult(result);

      // Refresh project list after import
      await fetchProjects();

      setMessage(`Successfully imported ${result.importedCount} projects to CMS!`);
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      console.error("Import error:", err);
      setRealImportResult({
        error: err.message || "Failed to process import."
      });
      setMessage(`Import failed: ${err.message}`);
    } finally {
      setRealImportLoading(false);
    }
  };

  const getStatusCount = (status) => projects.filter(p => p.status === status).length;

  const renderDashboard = () => {
    return (
      <section className="dashboard">
        <div className="section-header">
          <h2>CMS Dashboard</h2>
          <p className="subtitle">Staff portal for managing the Capstone Impact Showcase</p>
        </div>

        <div className="stats-grid">
          <div className="stat-card border-draft">
            <label>Submissions</label>
            <div className="stat-val">{getStatusCount('submitted') + getStatusCount('draft')}</div>
          </div>
          <div className="stat-card border-pending">
            <label>In Review</label>
            <div className="stat-val">{getStatusCount('in_review') + getStatusCount('awaiting_ocr') + getStatusCount('changes_requested')}</div>
          </div>
          <div className="stat-card border-approved">
            <label>Approved</label>
            <div className="stat-val">{getStatusCount('approved') + getStatusCount('preview_sent') + getStatusCount('student_confirmed')}</div>
          </div>
          <div className="stat-card border-published">
            <label>Live on Duda</label>
            <div className="stat-val">{publishedStatus.exists ? publishedStatus.count : 0}</div>
          </div>
        </div>

        <div className="workflow-panel" style={{
          background: 'white',
          padding: '2rem',
          borderRadius: '12px',
          marginTop: '20px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
          border: '1px solid var(--border)'
        }}>
          <h3 style={{ color: 'var(--primary)', marginBottom: '0.5rem' }}>Staff Publishing Workflow</h3>
          <p className="subtitle" style={{ marginBottom: '2rem' }}>From Submission to Public Showcase</p>

          <div className="workflow-steps" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '2rem',
            marginTop: '1.5rem'
          }}>
            {[
              { n: 1, t: 'Submission', d: 'Student/Group uploads files and metadata.' },
              { n: 2, t: 'OCR Assist', d: 'Conceptual AI extracts and validates data.' },
              { n: 3, t: 'Staff Review', d: 'Admin verifies accuracy and formatting.' },
              { n: 4, t: 'Clarifications', d: 'Staff requests changes if data is missing.' },
              { n: 5, t: 'Student Proof', d: 'Send private preview to student group.' },
              { n: 6, t: 'Confirmation', d: 'Student confirms the proof is correct.' },
              { n: 7, t: 'Approval', d: 'Staff marks project ready for publication.' },
              { n: 8, t: 'Publishing', d: 'One-click sync to Duda stable feed.' }
            ].map(s => (
              <div key={s.n} className="workflow-step" style={{ display: 'flex', gap: '1rem' }}>
                <div className="step-num" style={{
                  background: 'var(--primary)',
                  color: 'white',
                  borderRadius: '50%',
                  width: '28px',
                  height: '28px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  fontSize: '0.8rem',
                  fontWeight: 'bold'
                }}>{s.n}</div>
                <div className="step-text">
                  <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--text)', fontSize: '0.9rem' }}>{s.t}</strong>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, lineHeight: '1.3' }}>{s.d}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="assistive-note" style={{
            marginTop: '2.5rem',
            padding: '1.25rem',
            background: '#f0f9ff',
            borderRadius: '12px',
            border: '1px solid #bae6fd',
            display: 'flex',
            gap: '1rem',
            alignItems: 'center'
          }}>
            <span style={{ fontSize: '1.5rem' }}>[AI]</span>
            <div style={{ fontSize: '0.85rem', color: '#0369a1' }}>
              <strong>Conceptual AI/OCR Assist:</strong> In the production version, the system will automatically scan uploaded posters
              and documents to pre-fill metadata fields and flag potential inconsistencies (e.g., student name mismatches or missing logos).
              Admin review remains the mandatory final gate before publication.
            </div>
          </div>
        </div>

        <div className="dashboard-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginTop: '2rem' }}>
          <div className="feed-status-card" style={{ background: 'white', padding: '2rem', borderRadius: '12px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', border: '1px solid var(--border)' }}>
            <h3 style={{ color: 'var(--primary)', marginBottom: '1rem' }}>Showcase Distribution</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
              Local Preview updates automatically after records are saved. The public Duda showcase updates only after clicking Publish to Duda.
            </p>

            {publishedStatus?.exists ? (
              <div className="feed-info" style={{ marginBottom: '1.5rem' }}>
                <div className="info-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Public Records Count:</span>
                  <span className="highlight" style={{ fontWeight: 'bold', color: 'var(--success)' }}>{publishedStatus.count}</span>
                </div>
                <div className="info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Last Distribution:</span>
                  <span>{new Date(publishedStatus.lastPublished).toLocaleString()}</span>
                </div>
              </div>
            ) : (
              <p style={{ marginBottom: '1.5rem' }}>Public showcase has not been published yet.</p>
            )}

            <div className="feed-actions" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
              <button onClick={handlePublishCloud} className="btn-primary" style={{ width: '100%' }} title="Syncs the local feed to the official Supabase storage. This update is what Duda actually displays.">
                Publish to Duda
              </button>
            </div>

            {cloudStatus && (
              <div className={`global-toast ${cloudStatus.type === 'error' ? 'error' : 'success'}`} style={{ marginTop: '1.5rem', marginBottom: 0, padding: '0.75rem' }}>
                {cloudStatus.message}
              </div>
            )}
          </div>

          <div className="system-health-card" style={{ background: 'white', padding: '2rem', borderRadius: '12px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', border: '1px solid var(--border)' }}>
             <h3 style={{ color: 'var(--primary)', marginBottom: '1rem' }}>Resource Connectivity</h3>
             <div className="info-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
                <span className="dot" style={{ background: 'var(--success)' }}></span>
                <span>Stable Feed URL: Connected</span>
             </div>
             <div className="info-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
                <span className="dot" style={{ background: 'var(--success)' }}></span>
                <span>Media Storage: Ready</span>
             </div>
             <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1.5rem' }}>
               All public-facing assets are served from the stable Supabase storage layer to ensure zero downtime during administrative updates.
             </p>
          </div>
        </div>
      </section>
    );
  };

  const renderProjectList = () => {
    const filteredProjects = statusFilter === 'all'
      ? projects
      : projects.filter(p => p.status === statusFilter);

    return (
      <section className="project-list">
        <div className="section-header">
          <h2>Project Repository</h2>
          <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Filter:</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'white',
                  cursor: 'pointer',
                  fontSize: '0.85rem'
                }}
              >
                <option value="all">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
                <option value="in_review">In Review</option>
                <option value="approved">Approved</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </div>
             <button className="btn-success" onClick={() => setView('import')}>+ Import project folders</button>
          </div>
        </div>
        <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '15px' }}>
          Use <strong>Import project folders</strong> to create CMS review records from one project folder or a parent batch folder. Importing does not publish to Duda.
        </p>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Year</th>
              <th>Program</th>
              <th>Status</th>
              <th>Duda Sync</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredProjects.map(p => {
              const sync = getDudaSyncStatus(p);
              return (
                <tr key={p.id}>
                  <td>
                    <strong>{p.title}</strong>
                    {(p.importBatchId || p.sourceFolder) && (
                      <span className="status-pill submitted" style={{ marginLeft: '8px', fontSize: '0.7rem', padding: '1px 6px' }}>Imported</span>
                    )}
                  </td>
                  <td>{p.year}</td>
                  <td>{p.program}</td>
                  <td><span className={`status-pill ${p.status}`}>{p.status.replace('_', ' ')}</span></td>
                  <td><span className={`status-pill sync-${sync.code}`}>{sync.label}</span></td>
                  <td>
                    <button className="btn-outline" onClick={() => handleEdit(p)}>Edit & Review</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
  };

  const setProjectStatus = (status) => {
    setCurrentProject(prev => ({ ...prev, status }));
    setMessage(`Status updated to: ${status.replace('_', ' ')}`);
    setTimeout(() => setMessage(null), 2000);
  };

  const toggleSection = (sectionName) => {
    setExpandedSections(prev => ({
      ...prev,
      [sectionName]: !prev[sectionName]
    }));
  };

  const renderProjectForm = () => {
    const layoutConfig = currentProject.layoutConfig || {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
      hiddenSections: []
    };

    const sections = layoutConfig.sectionOrder || ['background', 'solution', 'snapshots', 'video', 'links'];
    const hidden = layoutConfig.hiddenSections || [];

    const moveSection = (idx, direction) => {
      const newOrder = [...sections];
      const targetIdx = idx + direction;
      if (targetIdx < 0 || targetIdx >= newOrder.length) return;

      const temp = newOrder[idx];
      newOrder[idx] = newOrder[targetIdx];
      newOrder[targetIdx] = temp;

      setCurrentProject(prev => ({
        ...prev,
        layoutConfig: {
          ...layoutConfig,
          sectionOrder: newOrder
        }
      }));
    };

    const toggleVisibility = (sec, isVisible) => {
      let newHidden = [...hidden];
      if (sec === 'externalLinks' || sec === 'links') {
        if (isVisible) {
          newHidden = newHidden.filter(s => s !== 'externalLinks' && s !== 'links');
        } else {
          if (!newHidden.includes('externalLinks')) newHidden.push('externalLinks');
          if (!newHidden.includes('links')) newHidden.push('links');
        }
      } else {
        if (isVisible) {
          newHidden = newHidden.filter(s => s !== sec);
        } else {
          if (!newHidden.includes(sec)) {
            newHidden.push(sec);
          }
        }
      }

      setCurrentProject(prev => ({
        ...prev,
        layoutConfig: {
          ...layoutConfig,
          hiddenSections: newHidden
        }
      }));
    };

    // Calculate real-time validation count
    const prepared = prepareProjectForSave(currentProject);
    const validationResult = validateProjectPackage(prepared);
    const { errors: validationErrors, warnings: validationWarnings } = validationResult;

    // Check if the form has unsaved changes
    const isDirty = JSON.stringify(currentProject) !== JSON.stringify(originalProject);

    // Dynamic availability check for media fallback warnings
    const hasPosterImage = !!(currentProject.poster && currentProject.poster.trim() !== '');
    const hasPosterPdf = !!(currentProject.posterPdf && currentProject.posterPdf.trim() !== '');
    const hasVideo = !!(currentProject.videoUrl && currentProject.videoUrl.trim() !== '');
    const hasSnapshots = !!(currentProject.snapshots && currentProject.snapshots.trim() !== '');
    const hasAccessibility = !!(currentProject.accessibilityText && currentProject.accessibilityText.trim() !== '');

    // Dynamic checklist items for right-side CMS publishing readiness
    const checklistItems = [
      {
        id: 'req_fields',
        label: 'Required fields complete',
        status: (currentProject.title && currentProject.year && currentProject.program && currentProject.discipline) ? 'Complete' : 'Missing',
        text: (currentProject.title && currentProject.year && currentProject.program && currentProject.discipline) ? 'Title, Program, Year & Discipline present' : 'Missing required metadata fields'
      },
      {
        id: 'poster_img',
        label: 'Poster image available',
        status: hasPosterImage ? 'Complete' : 'Warning',
        text: hasPosterImage ? 'Poster image URL set' : 'No poster image (PDF will fallback)'
      },
      {
        id: 'poster_pdf',
        label: 'Poster PDF available',
        status: hasPosterPdf ? 'Complete' : 'Warning',
        text: hasPosterPdf ? 'Poster PDF link set' : 'Missing PDF download resource'
      },
      {
        id: 'accessibility',
        label: 'Accessibility/alt text present',
        status: hasAccessibility ? 'Complete' : 'Warning',
        text: hasAccessibility ? 'Accessibility alt text present' : 'Alt text missing (Accessibility risk)'
      },
      {
        id: 'layout_preset',
        label: 'Visual template selected',
        status: (layoutConfig.templateId && ['poster_showcase', 'technical_detail', 'media_rich'].includes(layoutConfig.templateId)) ? 'Complete' : 'Missing',
        text: (layoutConfig.templateId && ['poster_showcase', 'technical_detail', 'media_rich'].includes(layoutConfig.templateId)) ? `Template Preset: ${layoutConfig.templateId.replace('_', ' ')}` : 'Invalid layout template ID'
      },
      {
        id: 'student_confirm',
        label: 'Student confirmation logged',
        status: (currentProject.status === 'student_confirmed' || currentProject.status === 'approved' || currentProject.status === 'published') ? 'Complete' : 'Warning',
        text: (currentProject.status === 'student_confirmed' || currentProject.status === 'approved' || currentProject.status === 'published') ? 'Student proof is confirmed' : 'Awaiting student proof approval'
      },
      {
        id: 'eligibility',
        label: 'Eligible for public feed',
        status: (validationErrors.length === 0) ? 'Complete' : 'Missing',
        text: (validationErrors.length === 0) ? 'Zero schema/validation errors' : `Has ${validationErrors.length} validation errors blocking publish`
      }
    ];

    const statusToStepIndex = (status) => {
      switch (status) {
        case 'draft':
        case 'submitted':
        case 'awaiting_ocr':
          return 1;
        case 'in_review':
        case 'changes_requested':
          return 2;
        case 'preview_sent':
          return 3;
        case 'student_confirmed':
          return 4;
        case 'approved':
          return 5;
        case 'published':
          return 6;
        default:
          return 1;
      }
    };

    const progressIndex = statusToStepIndex(currentProject.status || 'submitted');
    const isWarningStatus = currentProject.status === 'changes_requested';
    const steps = [
      { label: 'Imported', index: 1 },
      { label: 'In Review', index: 2 },
      { label: 'Proof Sent', index: 3 },
      { label: 'Student Confirmed', index: 4 },
      { label: 'Approved', index: 5 },
      { label: 'Published', index: 6 }
    ];

    return (
      <section className="project-form">
        <div className="section-header" style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ fontSize: '1.75rem', fontWeight: '700' }}>Project Publishing Workspace</h2>
            <p className="subtitle" style={{ fontSize: '0.85rem' }}>Review content, validate readiness, configure the public layout, and manage publishing status.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              className="btn-back-link"
              onClick={() => setView('list')}
              style={{
                background: 'none',
                border: 'none',
                color: '#64748b',
                fontSize: '0.9rem',
                cursor: 'pointer',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontWeight: '500',
                transition: 'color 0.2s'
              }}
            >
              &larr; Back to project repository
            </button>
          </div>
        </div>

        {/* TOP MAIN HEADER SUMMARY (COMPACT SUMMARY) */}
        <div className="project-review-header-card" style={{ padding: '0.85rem 1.15rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <span className="badge-program-year" style={{ margin: 0, fontSize: '0.78rem', color: '#475569', fontWeight: '500' }}>
                {currentProject.program || 'No Program'} &bull; {currentProject.year || 'No Year'} &bull; {currentProject.discipline || 'No Discipline'}
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <span className={`status-pill ${currentProject.status || 'submitted'}`} style={{ fontSize: '0.68rem', padding: '0.18rem 0.45rem' }}>
                  CMS: {(() => {
                    const status = currentProject.status || 'submitted';
                    return status.split(/[\s_]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                  })()}
                </span>
                {(() => {
                  const sync = getDudaSyncStatus(currentProject);
                  return (
                    <span className={`status-pill sync-${sync.code}`} style={{ fontSize: '0.68rem', padding: '0.18rem 0.45rem' }}>
                      Duda: {sync.label}
                    </span>
                  );
                })()}
              </div>
            </div>
            <h2 className="project-title-display" style={{ margin: 0, fontSize: '1.35rem', fontWeight: '800', color: 'var(--primary)', lineHeight: '1.2' }}>
              {currentProject.title || 'Untitled Project'}
            </h2>
          </div>
        </div>

        {/* TWO-COLUMN CMS REVIEW WORKSPACE */}
        <form onSubmit={handleSave} style={{ paddingBottom: '140px' }}>
          <div className="cms-review-workspace">

            {/* LEFT MAIN EDIT COLUMN */}
            <div className="cms-main-column">

              {/* SECTION 1: Validation & AI Checks (Default Open) */}
              <div className="accordion-card">
                <button
                  type="button"
                  className="accordion-header"
                  onClick={() => toggleSection('validation')}
                >
                  <div className="accordion-header-left">
                    <span className="accordion-icon">{expandedSections.validation ? '▼' : '▶'}</span>
                    <span className="accordion-title">Validation & AI Checks</span>
                  </div>
                  <span className="accordion-badge-pill">
                    {validationErrors.length > 0 ? (
                      <span className="accordion-badge error">❌ {validationErrors.length} Error{validationErrors.length > 1 ? 's' : ''}</span>
                    ) : validationWarnings.length > 0 ? (
                      <span className="accordion-badge warning">⚠️ {validationWarnings.length} Warning{validationWarnings.length > 1 ? 's' : ''}</span>
                    ) : (
                      <span className="accordion-badge success">✅ Clean</span>
                    )}
                  </span>
                </button>
                {expandedSections.validation && (
                  <div className="accordion-body">
                    <div className="ai-assist-panel" style={{
                      background: '#f8fafc',
                      padding: '1.5rem',
                      borderRadius: '12px',
                      marginBottom: '1.5rem',
                      border: '1px dashed #cbd5e1'
                    }}>
                      <h4 style={{ color: '#475569', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span>[AI]</span> AI/OCR Assistive Analysis (Prototype)
                      </h4>
                      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                         <div style={{ background: '#ecfdf5', color: '#047857', padding: '0.4rem 0.8rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: '600', border: '1px solid #10b981' }}>OK Poster Consistency: High</div>
                         <div style={{ background: '#fffbeb', color: '#b45309', padding: '0.4rem 0.8rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: '600', border: '1px solid #f59e0b' }}>!! Field Mismatch: Industry Partner</div>
                         <div style={{ background: '#f0f9ff', color: '#0369a1', padding: '0.4rem 0.8rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: '600', border: '1px solid #0ea5e9' }}>(i) OCR Suggestion: 5 Team Members found</div>
                      </div>
                      <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '1rem', fontStyle: 'italic' }}>
                        Note: These flags are conceptual placeholders for future OCR integration.
                      </p>
                    </div>

                    <div className="validation-details-console">
                      <h4 style={{ color: '#0f172a', marginBottom: '1rem' }}>Pre-flight Validation Console Logs</h4>
                      <div style={{
                        background: '#0f172a',
                        color: '#38bdf8',
                        padding: '1.25rem',
                        borderRadius: '8px',
                        fontFamily: 'monospace',
                        fontSize: '0.85rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem',
                        maxHeight: '250px',
                        overflowY: 'auto'
                      }}>
                        {validationErrors.map((err, i) => (
                          <div key={`err-${i}`} style={{ color: '#f87171' }}>✖ [ERROR] {err}</div>
                        ))}
                        {validationWarnings.map((warn, i) => (
                          <div key={`warn-${i}`} style={{ color: '#fbbf24' }}>⚠️ [WARNING] {warn}</div>
                        ))}
                        {validationErrors.length === 0 && validationWarnings.length === 0 && (
                          <div style={{ color: '#4ade80' }}>✓ [SUCCESS] All layout structures and URLs fully compliant. No errors or warnings found. Ready to publish.</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* SECTION 2: Content & Metadata (Default Open) */}
              <div className="accordion-card">
                <button
                  type="button"
                  className="accordion-header"
                  onClick={() => toggleSection('content')}
                >
                  <div className="accordion-header-left">
                    <span className="accordion-icon">{expandedSections.content ? '▼' : '▶'}</span>
                    <span className="accordion-title">Content & Metadata</span>
                  </div>
                  <span className="accordion-status-text">Title, Summary, Team & Supervisor</span>
                </button>
                {expandedSections.content && (
                  <div className="accordion-body">
                    <div className="form-grid">
                      <div className="form-group full-width">
                        <label>Project Title*</label>
                        <input type="text" value={currentProject.title || ''} onChange={e => setCurrentProject({...currentProject, title: e.target.value})} required />
                      </div>
                      <div className="form-group full-width">
                        <label>Public Summary* (Short - Listing view)</label>
                        <textarea value={currentProject.summary || ''} onChange={e => setCurrentProject({...currentProject, summary: e.target.value})} required rows="2" />
                      </div>
                      <div className="form-group full-width">
                        <label>Project Background</label>
                        <textarea value={currentProject.background || ''} onChange={e => setCurrentProject({...currentProject, background: e.target.value})} rows="3" />
                      </div>
                      <div className="form-group full-width">
                        <label>The Solution / Impact</label>
                        <textarea value={currentProject.solution || ''} onChange={e => setCurrentProject({...currentProject, solution: e.target.value})} rows="3" />
                      </div>
                      <div className="form-group full-width">
                        <label>Poster Full Text (For Search & SEO)</label>
                        <textarea value={currentProject.posterText || ''} onChange={e => setCurrentProject({...currentProject, posterText: e.target.value})} rows="5" />
                      </div>
                      <div className="form-group">
                        <label>Team Members* (Comma separated)</label>
                        <input type="text" value={currentProject.teamMembers || ''} onChange={e => setCurrentProject({...currentProject, teamMembers: e.target.value})} required />
                      </div>
                      <div className="form-group">
                        <label>Group Name</label>
                        <input type="text" value={currentProject.groupName || ''} onChange={e => setCurrentProject({...currentProject, groupName: e.target.value})} />
                      </div>
                      <div className="form-group">
                        <label>Academic Supervisor</label>
                        <input type="text" value={currentProject.academicSupervisor || ''} onChange={e => setCurrentProject({...currentProject, academicSupervisor: e.target.value})} />
                      </div>
                      <div className="form-group">
                        <label>Industry Partner</label>
                        <input type="text" value={currentProject.industryPartner || ''} onChange={e => setCurrentProject({...currentProject, industryPartner: e.target.value})} />
                      </div>
                      <div className="form-group">
                        <label>Industry Sector (required for feed)</label>
                        <input type="text" value={currentProject.industry || 'Technology'} onChange={e => setCurrentProject({...currentProject, industry: e.target.value})} />
                      </div>
                      <div className="form-group">
                        <label>Academic Year*</label>
                        <input type="text" value={currentProject.year || ''} onChange={e => setCurrentProject({...currentProject, year: e.target.value})} required />
                      </div>
                      <div className="form-group">
                        <label>Study Program*</label>
                        <input type="text" value={currentProject.program || ''} onChange={e => setCurrentProject({...currentProject, program: e.target.value, studyProgram: e.target.value})} required />
                      </div>
                      <div className="form-group">
                        <label>Primary Discipline*</label>
                        <input type="text" value={currentProject.discipline || ''} onChange={e => setCurrentProject({...currentProject, discipline: e.target.value})} required />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* SECTION 3: Media & Files (Default Collapsed) */}
              <div className="accordion-card">
                <button
                  type="button"
                  className="accordion-header"
                  onClick={() => toggleSection('media')}
                >
                  <div className="accordion-header-left">
                    <span className="accordion-icon">{expandedSections.media ? '▼' : '▶'}</span>
                    <span className="accordion-title">Media & Files</span>
                  </div>
                  <span className="accordion-status-text">
                    {(hasPosterImage || hasSnapshots) ? 'Poster + snapshots' : 'Needs media'}
                  </span>
                </button>
                {expandedSections.media && (
                  <div className="accordion-body">
                    {(currentProject.importBatchId || currentProject.sourceFolder) ? (
                      <>
                        <div style={{
                          background: '#f8fafc',
                          padding: '0.75rem 1rem',
                          borderRadius: '6px',
                          border: '1px solid var(--border)',
                          marginBottom: '1rem',
                          fontSize: '0.85rem',
                          color: 'var(--text-muted)',
                          lineHeight: '1.4'
                        }}>
                          Imported assets are stored in Supabase Storage. These source links are used for CMS preview and Duda publishing after approval.
                        </div>
                        <div style={{
                          display: 'inline-block',
                          background: '#f0fdf4',
                          color: '#15803d',
                          border: '1px solid #bbf7d0',
                          padding: '0.25rem 0.75rem',
                          borderRadius: '999px',
                          fontSize: '0.8rem',
                          fontWeight: '600',
                          marginBottom: '1rem'
                        }}>
                          Source: imported project folder
                        </div>
                      </>
                    ) : (
                      <div style={{
                        background: '#f8fafc',
                        padding: '0.75rem 1rem',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        marginBottom: '1rem',
                        fontSize: '0.85rem',
                        color: 'var(--text-muted)',
                        lineHeight: '1.4'
                      }}>
                        These media source links are used for CMS preview and Duda publishing. Folder-imported projects will automatically store files in Supabase Storage.
                      </div>
                    )}
                    <div className="form-grid">
                      <div className="form-group">
                        <label>Poster image source</label>
                        <input type="url" value={currentProject.poster || ''} onChange={e => setCurrentProject({...currentProject, poster: e.target.value})} placeholder="https://..." />
                        <p className="field-helper">Production: Secure file upload to RMIT S3.</p>
                      </div>
                      <div className="form-group">
                        <label>Poster PDF source</label>
                        <input type="url" value={currentProject.posterPdf || ''} onChange={e => setCurrentProject({...currentProject, posterPdf: e.target.value})} placeholder="https://..." />
                        <p className="field-helper">Required for "Get Poster" button in detail page.</p>
                      </div>
                      <div className="form-group full-width">
                        <label>Project snapshots / gallery sources</label>
                        <textarea value={currentProject.snapshots || ''} onChange={e => setCurrentProject({...currentProject, snapshots: e.target.value})} rows="4" placeholder="https://..." />
                      </div>
                      <div className="form-group">
                        <label>Image Alt Text</label>
                        <input type="text" value={currentProject.imageAlt || ''} onChange={e => setCurrentProject({...currentProject, imageAlt: e.target.value})} placeholder="Description for accessibility..." />
                      </div>
                      <div className="form-group">
                        <label>Video source</label>
                        <input type="url" value={currentProject.videoUrl || ''} onChange={e => setCurrentProject({...currentProject, videoUrl: e.target.value})} placeholder="https://..." />
                        <p className="field-helper">Optional. Used by Media Rich layouts when a project video is available.</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* SECTION 4: Public Layout (Default Open) */}
              <div className="accordion-card">
                <button
                  type="button"
                  className="accordion-header"
                  onClick={() => toggleSection('layout')}
                >
                  <div className="accordion-header-left">
                    <span className="accordion-icon">{expandedSections.layout ? '▼' : '▶'}</span>
                    <span className="accordion-title">Public Layout</span>
                  </div>
                  <span className="accordion-status-text">
                    {layoutConfig.templateId === 'poster_showcase' ? "Poster Showcase" :
                     layoutConfig.templateId === 'technical_detail' ? "Technical Detail" :
                     layoutConfig.templateId === 'media_rich' ? "Media Rich" : "Custom Layout"}
                  </span>
                </button>
                {expandedSections.layout && (
                  <div className="accordion-body">
                    <div className="public-layout-container">

                      <div className="layout-helper-intro" style={{
                        background: '#f8fafc',
                        padding: '1.25rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border)',
                        marginBottom: '1.5rem',
                        fontSize: '0.85rem',
                        color: 'var(--text-muted)'
                      }}>
                        <p style={{ margin: 0 }}>
                          <strong>CMS-controlled Layout Presets:</strong> These are custom visual presets rendered dynamically inside a single reusable Duda detail page, not native Duda page templates.
                          Staff can select approved templates, choose featured media, hide/show sections, and reorder supported body sections.
                        </p>
                      </div>

                      {/* Sub-panel A: Visual Template Presets */}
                      <div className="layout-panel-card" style={{
                        background: 'white',
                        padding: '1.5rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border)',
                        marginBottom: '1.5rem'
                      }}>
                        <div className="layout-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
                          <h4 style={{ color: 'var(--primary)', margin: 0, fontSize: '1rem', fontWeight: '700' }}>Template Preset</h4>
                          <span className="layout-helper-pill" style={{ background: '#e0f2fe', color: '#0369a1', fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>Visual Presets</span>
                        </div>

                        {/* Visual Template Cards */}
                        <div className="template-cards-grid" style={{ marginBottom: '1.25rem' }}>
                          {[
                            { id: 'poster_showcase', label: 'Poster Showcase', desc: 'Best for poster-based capstone displays.', icon: '🖼️' },
                            { id: 'technical_detail', label: 'Technical Detail', desc: 'Best for research, software, or explanation-heavy projects.', icon: '📄' },
                            { id: 'media_rich', label: 'Media Rich', desc: 'Best for demo, video, robotics, or gallery-heavy projects.', icon: '✨' }
                          ].map(tmpl => {
                            const isActive = layoutConfig.templateId === tmpl.id;
                            return (
                              <div
                                key={tmpl.id}
                                className={`template-card ${isActive ? 'active' : ''}`}
                                onClick={() => {
                                  setCurrentProject(prev => ({
                                    ...prev,
                                    layoutConfig: {
                                      ...layoutConfig,
                                      templateId: tmpl.id
                                    }
                                  }));
                                }}
                                style={{
                                  border: isActive ? '2px solid var(--primary)' : '1px solid var(--border)',
                                  borderRadius: '8px',
                                  padding: '1rem',
                                  cursor: 'pointer',
                                  background: isActive ? '#f0f4f8' : 'white',
                                  transition: 'all 0.2s',
                                  display: 'flex',
                                  gap: '0.75rem',
                                  alignItems: 'center'
                                }}
                              >
                                <span style={{ fontSize: '1.5rem' }}>{tmpl.icon}</span>
                                <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                                  <strong style={{ fontSize: '0.9rem', color: 'var(--primary)' }}>{tmpl.label}</strong>
                                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{tmpl.desc}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Dropdown kept for fallback safety */}
                        <div className="form-group" style={{ margin: 0, maxWidth: '500px' }}>
                          <label style={{ fontWeight: 'normal', fontSize: '0.85rem' }}>Visual Preset Template Dropdown</label>
                          <select
                            value={layoutConfig.templateId}
                            onChange={e => setCurrentProject({
                              ...currentProject,
                              layoutConfig: {
                                ...layoutConfig,
                                templateId: e.target.value
                              }
                            })}
                          >
                            <option value="poster_showcase">Poster Showcase (Standard Layout)</option>
                            <option value="technical_detail">Technical Detail (Deep Dive Columns)</option>
                            <option value="media_rich">Media Rich (Hero Snaps/Video Spotlight)</option>
                          </select>
                        </div>
                      </div>

                      {/* Sub-panel B: Featured/Hero Media */}
                      <div className="layout-panel-card" style={{
                        background: 'white',
                        padding: '1.5rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border)',
                        marginBottom: '1.5rem'
                      }}>
                        <div className="layout-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
                          <h4 style={{ color: 'var(--primary)', margin: 0, fontSize: '1rem', fontWeight: '700' }}>Featured / Hero Media</h4>
                          <span className="layout-helper-pill" style={{ background: '#fef3c7', color: '#d97706', fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>Hero media is controlled separately.</span>
                        </div>

                        {/* Live media availability indicators */}
                        <div className="media-availability-indicators" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                          <span className={`media-availability-badge ${hasPosterImage ? 'available' : 'unavailable'}`} style={{
                            fontSize: '0.7rem',
                            padding: '0.25rem 0.5rem',
                            borderRadius: '4px',
                            fontWeight: '600',
                            background: hasPosterImage ? '#d1fae5' : '#fee2e2',
                            color: hasPosterImage ? '#065f46' : '#991b1b',
                            border: `1px solid ${hasPosterImage ? '#a7f3d0' : '#fca5a5'}`
                          }}>
                            Poster: {hasPosterImage ? 'Available' : 'Unavailable'}
                          </span>
                          <span className={`media-availability-badge ${hasVideo ? 'available' : 'unavailable'}`} style={{
                            fontSize: '0.7rem',
                            padding: '0.25rem 0.5rem',
                            borderRadius: '4px',
                            fontWeight: '600',
                            background: hasVideo ? '#d1fae5' : '#fee2e2',
                            color: hasVideo ? '#065f46' : '#991b1b',
                            border: `1px solid ${hasVideo ? '#a7f3d0' : '#fca5a5'}`
                          }}>
                            Video: {hasVideo ? 'Available' : 'Unavailable'}
                          </span>
                          <span className={`media-availability-badge ${hasSnapshots ? 'available' : 'unavailable'}`} style={{
                            fontSize: '0.7rem',
                            padding: '0.25rem 0.5rem',
                            borderRadius: '4px',
                            fontWeight: '600',
                            background: hasSnapshots ? '#d1fae5' : '#fee2e2',
                            color: hasSnapshots ? '#065f46' : '#991b1b',
                            border: `1px solid ${hasSnapshots ? '#a7f3d0' : '#fca5a5'}`
                          }}>
                            Gallery: {hasSnapshots ? 'Available' : 'Unavailable'}
                          </span>
                        </div>

                        <div className="form-group" style={{ margin: 0, maxWidth: '500px' }}>
                          <label style={{ fontWeight: 'normal', fontSize: '0.85rem' }}>Featured/Hero Media Option</label>
                          <select
                            value={layoutConfig.featuredMedia}
                            onChange={e => setCurrentProject({
                              ...currentProject,
                              layoutConfig: {
                                ...layoutConfig,
                                featuredMedia: e.target.value
                              }
                            })}
                          >
                            <option value="poster" disabled={!hasPosterImage}>Poster Image {!hasPosterImage ? " (Unavailable)" : ""}</option>
                            <option value="video" disabled={!hasVideo}>Project Video {!hasVideo ? " (Unavailable)" : ""}</option>
                            <option value="snapshots" disabled={!hasSnapshots}>Project Snapshots / Gallery {!hasSnapshots ? " (Unavailable)" : ""}</option>
                            <option value="none">None (Text Main Focus)</option>
                          </select>
                          <p className="field-helper" style={{ marginTop: '0.5rem', fontStyle: 'italic', fontSize: '0.75rem', color: '#64748b' }}>
                            ℹ️ Unavailable media options are disabled. If the selected media is unavailable, the renderer falls back to the next available public media.
                          </p>
                        </div>
                      </div>

                      {/* Sub-panel C: Body Section Order */}
                      <div className="layout-panel-card" style={{
                        background: 'white',
                        padding: '1.5rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border)',
                        marginBottom: '1.5rem'
                      }}>
                        <div className="layout-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
                          <h4 style={{ color: 'var(--primary)', margin: 0, fontSize: '1rem', fontWeight: '700' }}>Body Section Order</h4>
                          <span className="layout-helper-pill" style={{ background: '#f1f5f9', color: '#475569', fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>Supporting sections</span>
                        </div>
                        <p className="field-helper" style={{ fontStyle: 'italic', fontSize: '0.75rem', color: '#64748b', margin: '0 0 1rem 0' }}>
                          ℹ️ Body order controls supporting sections below the template hero.
                        </p>

                        {/* Improved Content block lists */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '600px' }}>
                          {sections.map((sec, idx) => {
                            return (
                              <div key={sec} style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '1rem',
                                background: '#f8fafc',
                                padding: '0.75rem 1rem',
                                borderRadius: '8px',
                                border: '1px solid var(--border)',
                                boxShadow: '0 1px 2px rgba(0,0,0,0.02)'
                              }}>
                                <span style={{ color: '#94a3b8', fontSize: '1rem', cursor: 'grab', userSelect: 'none' }} title="Drag handle (Visual placeholder)">☰</span>
                                <span style={{ fontWeight: '600', width: '200px', textTransform: 'capitalize', fontSize: '0.85rem', color: 'var(--primary)' }}>
                                  {sec === 'background' ? 'Project Background' :
                                   sec === 'solution' ? 'Project Solution' :
                                   sec === 'snapshots' ? 'Project Snapshots / Gallery' :
                                   sec === 'video' ? 'Project Video' :
                                   sec === 'links' || sec === 'externalLinks' ? 'Links & Resources' : sec}
                                </span>
                                <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.25rem' }}>
                                  <button type="button" className="btn-outline" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} disabled={idx === 0} onClick={() => moveSection(idx, -1)}>▲ Up</button>
                                  <button type="button" className="btn-outline" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} disabled={idx === sections.length - 1} onClick={() => moveSection(idx, 1)}>▼ Down</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Sub-panel D: Section Visibility */}
                      <div className="layout-panel-card" style={{
                        background: 'white',
                        padding: '1.5rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border)'
                      }}>
                        <div className="layout-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
                          <h4 style={{ color: 'var(--primary)', margin: 0, fontSize: '1rem', fontWeight: '700' }}>Section Visibility</h4>
                          <span className="layout-helper-pill" style={{ background: '#ecfdf5', color: '#047857', fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>Toggle Blocks</span>
                        </div>
                        <p className="field-helper" style={{ fontStyle: 'italic', fontSize: '0.75rem', color: '#64748b', margin: '0 0 1.25rem 0' }}>
                          ℹ️ Hidden sections remain stored in the CMS but are removed from the public detail page. Configure which content blocks are active.
                        </p>
                        <div className="visibility-grid">
                          {[
                            { key: 'summary', label: 'Public Summary' },
                            { key: 'background', label: 'Project Background' },
                            { key: 'solution', label: 'Project Solution' },
                            { key: 'poster', label: 'Poster Image' },
                            { key: 'posterPdf', label: 'Poster PDF Download' },
                            { key: 'snapshots', label: 'Project Snapshots / Gallery' },
                            { key: 'video', label: 'Project Video' },
                            { key: 'externalLinks', label: 'Links & Resources' },
                            { key: 'accessibilityText', label: 'Accessibility / Full Text' },
                            { key: 'team', label: 'Team' },
                            { key: 'metadata', label: 'Specifications / Metadata' },
                            { key: 'citations', label: 'Citations' }
                          ].map(({ key, label }) => {
                            const isHidden = hidden.includes(key);
                            const isChecked = !isHidden;
                            return (
                              <label key={key} className={`visibility-card-label ${isChecked ? 'active' : 'inactive'}`} style={{
                                opacity: isChecked ? 1 : 0.6
                              }}>
                                <input
                                  type="checkbox"
                                  className="visibility-checkbox"
                                  checked={isChecked}
                                  onChange={e => toggleVisibility(key, e.target.checked)}
                                />
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span className="visibility-card-text" style={{ fontSize: '0.8rem', fontWeight: '600' }}>{label}</span>
                                  <span style={{ fontSize: '0.65rem', color: isChecked ? '#15803d' : '#64748b' }}>
                                    {isChecked ? '✓ Show Section' : '✕ Hide Section'}
                                  </span>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* SECTION 5: Admin Notes & Status (Default Collapsed) */}
              <div className="accordion-card">
                <button
                  type="button"
                  className="accordion-header"
                  onClick={() => toggleSection('admin')}
                >
                  <div className="accordion-header-left">
                    <span className="accordion-icon">{expandedSections.admin ? '▼' : '▶'}</span>
                    <span className="accordion-title">Admin Notes & Status</span>
                  </div>
                  <span className="accordion-status-text">
                    {currentProject.status ? currentProject.status.toUpperCase().replace('_', ' ') : 'SUBMITTED'}
                  </span>
                </button>
                {expandedSections.admin && (
                  <div className="accordion-body">
                    <div className="form-grid">
                      {/* Kept here too for double-accessibility, though also available in right rail */}
                      <div className="form-group">
                        <label>Internal Status Override</label>
                        <select value={currentProject.status || 'submitted'} onChange={e => setCurrentProject({...currentProject, status: e.target.value})}>
                          <option value="draft">Draft (Internal)</option>
                          <option value="submitted">Submitted</option>
                          <option value="awaiting_ocr">Awaiting OCR/AI</option>
                          <option value="in_review">In Review</option>
                          <option value="changes_requested">Changes Requested</option>
                          <option value="preview_sent">Preview Sent</option>
                          <option value="student_confirmed">Student Confirmed</option>
                          <option value="approved">Approved (Queue for Publish)</option>
                          <option value="published">Published (Live)</option>
                          <option value="archived">Archived</option>
                        </select>
                      </div>
                      <div className="form-group full-width">
                        <label>Review Notes (Shared with Student Group)</label>
                        <textarea value={currentProject.reviewNotes || ''} onChange={e => setCurrentProject({...currentProject, reviewNotes: e.target.value})} rows="2" />
                      </div>
                      <div className="form-group full-width">
                        <label>Internal Staff Notes (Private - Not for Students/Public)</label>
                        <textarea value={currentProject.internalNotes || ''} onChange={e => setCurrentProject({...currentProject, internalNotes: e.target.value})} rows="2" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT STICKY PUBLISHING RAIL */}
            <div className="cms-right-rail-container">
              <div className="cms-right-rail">

                {/* Panel 1: Review & Publishing Control */}
                {/* Panel 1: Review & Publishing Control */}
                <div className="right-rail-card">
                  <h3 className="right-rail-title">Publishing & Status</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem', display: 'block' }}>CMS Status</label>
                      <select
                        value={currentProject.status || 'submitted'}
                        onChange={e => setCurrentProject({...currentProject, status: e.target.value})}
                        style={{ padding: '0.4rem 0.5rem', fontSize: '0.8rem', width: '100%', borderRadius: '6px', border: '1px solid var(--border)' }}
                      >
                        <option value="draft">Draft (Internal)</option>
                        <option value="submitted">Submitted</option>
                        <option value="awaiting_ocr">Awaiting OCR/AI</option>
                        <option value="in_review">In Review</option>
                        <option value="changes_requested">Changes Requested</option>
                        <option value="preview_sent">Preview Sent</option>
                        <option value="student_confirmed">Student Confirmed</option>
                        <option value="approved">Approved (Queue for Publish)</option>
                        <option value="published">Published (Live)</option>
                        <option value="archived">Archived</option>
                      </select>
                    </div>
                    {isDirty && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#b45309', fontSize: '0.75rem', fontWeight: '500', marginTop: '0.2rem' }}>
                        <span className="dirty-dot" style={{ color: '#b45309' }}>●</span> Unsaved CMS changes
                      </div>
                    )}
                  </div>
                </div>

                {/* Panel 2: Duda Sync Status */}
                <div className="right-rail-card" style={{ borderLeft: '4px solid var(--primary)' }}>
                  <h3 className="right-rail-title">Duda Sync Status</h3>
                  {(() => {
                    const sync = getDudaSyncStatus(currentProject);
                    const isUnpublished = sync.code === 'unpublished_changes';
                    const isUnknown = sync.code === 'unknown';
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Sync State:</span>
                          <span className={`status-pill sync-${sync.code}`} style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem' }}>
                            {sync.label}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Last Published:</span>
                          <strong style={{ fontSize: '0.75rem' }}>
                            {currentProject.lastPublishedAt ? new Date(currentProject.lastPublishedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'Never'}
                          </strong>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Live Template:</span>
                          <strong style={{ textTransform: 'capitalize', fontSize: '0.75rem' }}>{(currentProject.lastPublishedTemplateId || 'None').replace('_', ' ')}</strong>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                          <span style={{ color: 'var(--text-muted)' }}>CMS Preview:</span>
                          <strong style={{ textTransform: 'capitalize', fontSize: '0.75rem' }}>{(layoutConfig.templateId || 'poster_showcase').replace('_', ' ')}</strong>
                        </div>

                        {isUnpublished && (
                          <div style={{
                            marginTop: '0.4rem',
                            padding: '0.6rem',
                            background: '#fff3e0',
                            border: '1px solid #ffe0b2',
                            borderRadius: '6px',
                            color: '#e65100',
                            fontSize: '0.7rem',
                            lineHeight: '1.3'
                          }}>
                            <strong>Unpublished Changes:</strong> saved CMS edits are not yet live. Use <strong>“Publish to Duda”</strong> from the dashboard to update.
                          </div>
                        )}

                        {isUnknown && (
                          <div style={{
                            marginTop: '0.4rem',
                            padding: '0.6rem',
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            borderRadius: '6px',
                            color: '#64748b',
                            fontSize: '0.7rem',
                            lineHeight: '1.3'
                          }}>
                            This project was published before sync tracking was added. It will be tracked after the next Duda publish.
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Panel 3: Workflow Progress Checklist */}
                <div className="right-rail-card">
                  <h3 className="right-rail-title">Workflow Progress</h3>
                  <div className="workflow-checklist" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {steps.map((step) => {
                      const isCompleted = step.index < progressIndex;
                      const isActive = step.index === progressIndex;

                      let statusText = '';
                      let icon = '○';
                      let color = '#94a3b8';
                      let fontWeight = 'normal';

                      if (isCompleted) {
                        icon = '✓';
                        color = 'var(--success)';
                        statusText = 'Completed';
                        fontWeight = '500';
                      } else if (isActive) {
                        icon = '●';
                        color = isWarningStatus ? 'var(--danger)' : 'var(--primary)';
                        statusText = isWarningStatus ? 'Changes Req' : 'Active';
                        fontWeight = 'bold';
                      } else {
                        statusText = 'Pending';
                      }

                      return (
                        <div key={step.index} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.6rem',
                          fontSize: '0.8rem',
                          color: isActive ? 'var(--text)' : '#64748b'
                        }}>
                          <span style={{
                            color: color,
                            fontSize: '0.9rem',
                            fontWeight: 'bold',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '18px',
                            height: '18px'
                          }}>
                            {icon}
                          </span>
                          <span style={{ fontWeight: fontWeight }}>
                            {step.label === 'In Review' && currentProject.status === 'changes_requested' ? 'Changes Requested' : step.label}
                          </span>
                          <span style={{
                            marginLeft: 'auto',
                            fontSize: '0.7rem',
                            color: color,
                            textTransform: 'uppercase',
                            fontWeight: '600'
                          }}>
                            {statusText}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Panel 4: Publishing Readiness Checklist */}
                <div className="right-rail-card">
                  <h3 className="right-rail-title">Publishing Readiness</h3>
                  <div className="readiness-checklist" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {checklistItems.map(item => {
                      let icon = '✓';
                      let color = '#10b981';
                      let bg = '#ecfdf5';
                      let border = '#a7f3d0';

                      if (item.status === 'Warning') {
                        icon = '⚠️';
                        color = '#d97706';
                        bg = '#fffbeb';
                        border = '#fef3c7';
                      } else if (item.status === 'Missing') {
                        icon = '❌';
                        color = '#ef4444';
                        bg = '#fef2f2';
                        border = '#fca5a5';
                      }

                      return (
                        <div
                          key={item.id}
                          className="readiness-item"
                          title={item.text}
                          style={{
                            display: 'flex',
                            gap: '0.4rem',
                            alignItems: 'flex-start',
                            padding: '0.4rem',
                            borderRadius: '6px',
                            background: bg,
                            border: `1px solid ${border}`,
                            fontSize: '0.75rem'
                          }}
                        >
                          <span style={{ color, fontWeight: 'bold', fontSize: '0.75rem', lineHeight: '1.2' }}>{icon}</span>
                          <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                            <strong style={{ color: '#1e293b', fontSize: '0.75rem' }}>{item.label}</strong>
                            <span style={{ color: '#64748b', fontSize: '0.65rem', lineHeight: '1.1' }}>{item.text}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Panel 5: Preview Section */}
                <div className="right-rail-card">
                  <h3 className="right-rail-title">Preview</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <button
                      type="button"
                      className="btn-action btn-mark-in-review"
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', border: '1px solid #bfdbfe', padding: '0.4rem', fontSize: '0.75rem' }}
                      onClick={() => {
                        const prepared = prepareProjectForSave(currentProject);
                        setPreviewProject(prepared);
                        setCameFromEdit(true);
                        setView('detail');
                      }}
                    >
                      👁️ Local Preview
                    </button>
                    <button
                      type="button"
                      className="btn-action"
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', padding: '0.4rem', fontSize: '0.75rem' }}
                      onClick={() => window.open('https://showcase.rmit.edu.vn', '_blank')}
                    >
                      🌐 Public Duda Site
                    </button>
                  </div>
                </div>

                {/* Panel 6: Lifecycle Management Actions */}
                <div className="right-rail-card">
                  <h3 className="right-rail-title">Lifecycle Actions</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                      <button type="button" className="btn-action btn-mark-in-review" style={{ padding: '0.4rem', fontSize: '0.75rem' }} onClick={() => setProjectStatus('in_review')}>In Review</button>
                      <button type="button" className="btn-action btn-request-changes" style={{ padding: '0.4rem', fontSize: '0.75rem' }} onClick={() => {
                        const note = prompt("Enter specific changes required (sent to student group):");
                        if (note) {
                          setCurrentProject({ ...currentProject, status: 'changes_requested', reviewNotes: note });
                          setMessage("Project marked as Changes Requested.");
                        }
                      }}>Needs Changes</button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                      <button type="button" className="btn-action btn-send-proof" style={{ padding: '0.4rem', fontSize: '0.75rem' }} onClick={() => {
                        setProjectStatus('preview_sent');
                        alert("STAKEHOLDER DEMO:\n\nIn the production system, this sends a secure one-time preview link to the student group: \n\nhttps://showcase.rmit.edu.vn/preview/" + (currentProject.id || 'temp-id'));
                      }}>Send Proof</button>
                      <button type="button" className="btn-action btn-student-confirmed" style={{ padding: '0.4rem', fontSize: '0.75rem' }} onClick={() => setProjectStatus('student_confirmed')}>Student Ok</button>
                    </div>

                    <button type="button" className="btn-success btn-action btn-approve" style={{ width: '100%', background: 'var(--success)', color: 'white', padding: '0.5rem', fontSize: '0.8rem', fontWeight: 'bold' }} onClick={() => setProjectStatus('approved')}>Approve for Publish</button>

                    {(currentProject.status === 'published' || currentProject.status === 'approved') && (
                      <button type="button" className="btn-outline btn-action btn-archive" style={{ width: '100%', borderColor: 'var(--danger)', color: 'var(--danger)', padding: '0.4rem', fontSize: '0.75rem' }} onClick={async () => {
                        if (window.confirm("Archive this project? It will be removed from the official showcase after the next 'Publish to Duda' action.")) {
                          const reason = prompt("Optional: Archive Reason (e.g. 'Project Withdrawn', 'Incorrect Data'):");

                          const baseProject = prepareProjectForSave(currentProject);
                          const updatedProject = {
                            ...baseProject,
                            status: 'archived',
                            archivedAt: new Date().toISOString(),
                            archiveReason: reason || 'Archived by staff'
                          };

                          setLoading(true);
                          try {
                            const res = await fetch(`${API_URL}/projects/${updatedProject.id}`, {
                              method: 'PUT',
                              headers: {
                                'Content-Type': 'application/json',
                                'x-admin-key': adminKey
                              },
                              body: JSON.stringify(updatedProject),
                            });

                            if (res.ok) {
                              alert("Project successfully ARCHIVED. It is now removed from the pending public queue.");
                              fetchProjects();
                              fetchFeedStatus();
                              fetchPublishedStatus();
                              setView('list');
                              setMessage("Project archived and saved.");
                              setTimeout(() => setMessage(null), 3000);
                            } else {
                              const errorData = await res.json().catch(() => ({}));
                              alert("Error archiving project: " + (errorData.error || res.statusText));
                            }
                          } catch (err) {
                            alert("Network error while archiving.");
                          } finally {
                            setLoading(false);
                          }
                        }
                      }}>Archive Project</button>
                    )}
                  </div>
                </div>

              </div>
            </div>

          </div>

          {/* STICKY SAVE BAR - AT BOTTOM OF VIEWPORT */}
          <div className="form-actions-sticky" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '1rem' }}>
            {isDirty && (
              <div className="unsaved-changes-indicator" style={{ marginRight: 'auto', margin: 0 }}>
                <span className="dirty-dot">●</span> Unsaved changes
              </div>
            )}
            <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontStyle: 'italic', maxWidth: '280px', textAlign: 'right', lineHeight: '1.2', opacity: 0.85 }}>
              Saving updates the CMS record only. It does not publish to Duda.
            </span>
            <button type="button" className="btn-cancel" onClick={() => setView('list')}>Cancel</button>
            <button type="submit" className="btn-primary" style={{ padding: '0.5rem 1.75rem', fontSize: '0.85rem', fontWeight: 'bold' }} disabled={loading}>
              {loading ? 'Processing...' : 'Save CMS Changes'}
            </button>
          </div>
        </form>
      </section>
    );
  };

  const renderBatchImport = () => {
    return (
      <section className="batch-import" style={{ padding: '1rem' }}>
        <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <div>
            <h2>Project Import Workspace</h2>
            <p className="subtitle">Import one project folder or a parent batch folder into the CMS for review.</p>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              className={realImportMode === 'single' ? 'btn-primary' : 'btn-outline'}
              style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', fontWeight: 'bold' }}
              onClick={() => {
                setRealImportMode('single');
                setRealImportFiles([]);
                setRealImportResult(null);
              }}
            >
              📁 Single Project Folder
            </button>
            <button
              type="button"
              className={realImportMode === 'batch' ? 'btn-primary' : 'btn-outline'}
              style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', fontWeight: 'bold' }}
              onClick={() => {
                setRealImportMode('batch');
                setRealImportFiles([]);
                setRealImportResult(null);
              }}
            >
              🗂️ Batch Folder
            </button>
          </div>
        </div>

        {/* Staff-friendly Import Guide */}
        <div style={{ background: '#f8fafc', padding: '1.25rem', borderRadius: '12px', border: '1px solid #e2e8f0', marginBottom: '2rem', fontSize: '0.85rem', color: '#475569' }}>
          <strong>💡 Staff Import Guide:</strong>
          <ul style={{ margin: '0.5rem 0 0 1.25rem', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <li><strong>Single Project Folder:</strong> Choose one project folder containing <code>project.json</code>, poster image, and poster PDF.</li>
            <li><strong>Batch Folder:</strong> Choose one parent folder containing multiple project folders. Each project folder must contain its own <code>project.json</code>.</li>
            <li>Importing creates <strong>CMS review records only (status: <code>In Review</code>)</strong>. It <strong>does not</strong> publish to Duda or update the public feed.</li>
            <li>Projects with <strong>Warnings</strong> (e.g. missing accessibility text) can still be reviewed. Projects with <strong>Errors</strong> are <strong>not</strong> imported.</li>
          </ul>
        </div>

        {/* Real Folder Dropzone Picker */}
        <div
          className="folder-dropzone"
          onClick={() => {
            const el = document.getElementById('folder-picker-input');
            if (el) el.click();
          }}
          style={{
            marginBottom: '1.5rem',
            background: realImportFiles.length > 0 ? '#f8fafc' : 'white',
            padding: '3rem 2rem',
            border: '2px dashed #cbd5e1',
            borderRadius: '16px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>
            {realImportMode === 'single' ? '📁' : '🗂️'}
          </div>
          <h3 style={{ marginBottom: '0.5rem', color: 'var(--primary)' }}>
            {realImportMode === 'single' ? 'Select a single project folder' : 'Select a parent batch folder'}
          </h3>
          <p style={{ color: '#64748b', fontSize: '0.9rem', maxWidth: '450px', margin: '0 auto 1.5rem' }}>
            {realImportMode === 'single'
              ? 'Click here to choose a local project folder containing project.json and assets.'
              : 'Click here to choose a parent folder containing multiple project folders.'
            }
          </p>
          <button type="button" className="btn-primary" style={{ pointerEvents: 'none' }}>
            {realImportMode === 'single' ? 'Select project folder' : 'Select batch folder'}
          </button>

          <input
            type="file"
            id="folder-picker-input"
            style={{ display: 'none' }}
            webkitdirectory=""
            directory=""
            multiple
            onChange={handleFolderSelect}
          />
        </div>

        {/* Selected files details / Import CTA */}
        {realImportFiles.length > 0 && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h4 style={{ color: '#166534', margin: '0 0 0.25rem 0' }}>
                  Selected Folder:
                </h4>
                <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#14532d' }}>
                  {realImportFiles[0].webkitRelativePath.split('/')[0]}
                </div>
                <div style={{ fontSize: '0.85rem', color: '#15803d', marginTop: '0.5rem' }}>
                  Detected <strong>{realImportFiles.length}</strong> files
                  {realImportMode === 'batch' && (
                    <span> across <strong>{countProjectsInBatch(realImportFiles)}</strong> project directories</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => {
                    setRealImportFiles([]);
                    setRealImportResult(null);
                  }}
                  disabled={realImportLoading}
                >
                  Clear Selection
                </button>
                <button
                  type="button"
                  className="btn-success"
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold' }}
                  onClick={handleRealImport}
                  disabled={realImportLoading}
                >
                  {realImportLoading ? 'Importing...' : (realImportMode === 'single' ? 'Scan & Import Project' : 'Scan & Import Batch')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Real Import Loading State */}
        {realImportLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '3rem', background: 'white', borderRadius: '12px', border: '1px solid var(--border)' }}>
            <div className="spinner" style={{ width: '40px', height: '40px', border: '4px solid #e2e8f0', borderTopColor: '#0f766e', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
            <h3 style={{ color: 'var(--primary)' }}>Importing packages & uploading assets...</h3>
            <p style={{ color: '#64748b', fontSize: '0.85rem', margin: 0 }}>This parses metadata, uploads files to Supabase Storage, and registers records as In Review.</p>
          </div>
        )}

        {/* Import Result display */}
        {realImportResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1.5rem' }}>
            {realImportResult.error ? (
              <div style={{ background: '#fef2f2', border: '1px solid #fee2e2', borderRadius: '12px', padding: '1.5rem', color: '#991b1b' }}>
                <h4 style={{ marginBottom: '0.5rem', fontWeight: 'bold' }}>✖ Import Failed</h4>
                <p style={{ margin: 0, fontSize: '0.9rem' }}>{realImportResult.error}</p>
              </div>
            ) : (
              <>
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px', padding: '1.25rem', color: '#166534', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ margin: '0 0 0.25rem 0', color: '#14532d' }}>Import Complete!</h3>
                    <p style={{ margin: 0, fontSize: '0.9rem' }}>
                      Batch: <code style={{ background: '#dcfce7', padding: '2px 6px', borderRadius: '4px' }}>{realImportResult.batchId}</code>
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '15px', textAlign: 'center' }}>
                    <div style={{ background: 'white', padding: '8px 16px', borderRadius: '8px', border: '1px solid #bbf7d0' }}>
                      <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#166534' }}>{realImportResult.importedCount}</div>
                      <div style={{ fontSize: '0.75rem', color: '#15803d' }}>Imported</div>
                    </div>
                    <div style={{ background: 'white', padding: '8px 16px', borderRadius: '8px', border: '1px solid #fef08a' }}>
                      <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#854d0e' }}>{realImportResult.warningCount}</div>
                      <div style={{ fontSize: '0.75rem', color: '#a16207' }}>Warnings</div>
                    </div>
                    <div style={{ background: 'white', padding: '8px 16px', borderRadius: '8px', border: '1px solid #fca5a5' }}>
                      <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#991b1b' }}>{realImportResult.errorCount}</div>
                      <div style={{ fontSize: '0.75rem', color: '#b91c1c' }}>Errors</div>
                    </div>
                  </div>
                </div>

                <div className="table-container" style={{ background: 'white', borderRadius: '12px', border: '1px solid var(--border)', padding: '1rem' }}>
                  <h3 style={{ marginBottom: '1rem', color: 'var(--primary)' }}>Import Results Summary</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Folder</th>
                        <th>Project Title</th>
                        <th>Import Status</th>
                        <th>Warnings</th>
                        <th>Errors</th>
                        <th>Detected Assets</th>
                        <th>Imported ID</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {realImportResult.projects && realImportResult.projects.map((pkg, idx) => {
                        const statusText = pkg.imported
                          ? (pkg.warnings && pkg.warnings.length > 0 ? 'Imported with warnings' : 'Imported')
                          : 'Error / Not imported';
                        const statusClass = pkg.imported
                          ? (pkg.warnings && pkg.warnings.length > 0 ? 'status-pill awaiting_ocr' : 'status-pill approved')
                          : 'status-pill archived';

                        return (
                          <tr key={idx}>
                            <td><code>{pkg.folder}</code></td>
                            <td>
                              <strong>{pkg.title || 'Untitled Project'}</strong>
                            </td>
                            <td>
                              <span className={statusClass}>
                                {statusText}
                              </span>
                            </td>
                            <td>
                              {pkg.warnings && pkg.warnings.length > 0 ? (
                                <ul style={{ margin: 0, paddingLeft: '1rem', color: '#b45309', fontSize: '0.8rem' }}>
                                  {pkg.warnings.map((w, i) => <li key={i}>{w}</li>)}
                                </ul>
                              ) : (
                                <span style={{ color: '#64748b' }}>None</span>
                              )}
                            </td>
                            <td>
                              {pkg.errors && pkg.errors.length > 0 ? (
                                <ul style={{ margin: 0, paddingLeft: '1rem', color: '#b91c1c', fontSize: '0.8rem' }}>
                                  {pkg.errors.map((e, i) => <li key={i}>{e}</li>)}
                                </ul>
                              ) : (
                                <span style={{ color: '#64748b' }}>None</span>
                              )}
                            </td>
                            <td>
                              <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                <span>🖼️ Poster: {pkg.assets?.poster ? '✅ Yes' : '❌ No'}</span>
                                <span>📄 PDF: {pkg.assets?.posterPdf ? '✅ Yes' : '❌ No'}</span>
                                <span>📸 Snapshots: {pkg.assets?.snapshots || 0}</span>
                                {(pkg.assets?.video || pkg.assets?.audio || pkg.assets?.model3d) && (
                                  <span style={{ color: '#0369a1', fontWeight: 'bold' }}>
                                    {[
                                      pkg.assets?.video && '📹 Video',
                                      pkg.assets?.audio && '🎵 Audio',
                                      pkg.assets?.model3d && '📦 3D Model'
                                    ].filter(Boolean).join(', ')}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              {pkg.id ? (
                                <code style={{ fontSize: '0.8rem' }}>{pkg.id}</code>
                              ) : (
                                <span style={{ color: '#94a3b8' }}>-</span>
                              )}
                            </td>
                            <td>
                              {pkg.imported && pkg.id ? (
                                <button
                                  type="button"
                                  className="btn-success"
                                  style={{ padding: '6px 12px', fontSize: '0.75rem', minHeight: 'unset', fontWeight: 'bold' }}
                                  onClick={() => {
                                    const found = projects.find(p => p.id === pkg.id);
                                    if (found) {
                                      handleEdit(found);
                                    } else {
                                      fetchProjects().then(() => {
                                        const reFound = projects.find(p => p.id === pkg.id);
                                        if (reFound) {
                                          handleEdit(reFound);
                                        }
                                      });
                                    }
                                  }}
                                >
                                  Edit & Review
                                </button>
                              ) : (
                                <span style={{ color: '#94a3b8' }}>N/A</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* Demo Example fallback block at bottom (demoted) */}
        <div style={{ marginTop: '4rem', borderTop: '1px solid var(--border)', paddingTop: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h4 style={{ color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Want to test with sample data?</h4>
            <p style={{ color: '#94a3b8', fontSize: '0.8rem', margin: 0 }}>You can load a simulated static demo batch to review layout mapping and pre-flight logs.</p>
          </div>
          <button
            type="button"
            className="btn-outline"
            onClick={handleLoadPackages}
            style={{ fontSize: '0.8rem', minHeight: 'unset', padding: '6px 12px' }}
          >
            Load Demo Example
          </button>
        </div>

        {/* Static pre-flight logs if demo packages are loaded */}
        {importPackages.length > 0 && (
          <div style={{ marginTop: '2rem', border: '1px solid #cbd5e1', borderRadius: '12px', padding: '1.5rem', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h4 style={{ color: 'var(--primary)', margin: 0 }}>Simulated Demo Batch (Read-Only Preview)</h4>
              <button
                type="button"
                className="btn-success"
                style={{ padding: '6px 12px', fontSize: '0.8rem', minHeight: 'unset', fontWeight: 'bold' }}
                onClick={handleMapValidProjects}
              >
                Map Valid Projects to CMS
              </button>
            </div>

            <div className="table-container" style={{ background: 'white', borderRadius: '12px', border: '1px solid var(--border)', padding: '1rem', marginBottom: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Package / Folder</th>
                    <th>Metadata Title</th>
                    <th>Included Assets</th>
                    <th>Intake Validation</th>
                    <th>Result / Action</th>
                  </tr>
                </thead>
                <tbody>
                  {importPackages.map(pkg => (
                    <tr key={pkg.id}>
                      <td><code>{pkg.sourceFolder}</code></td>
                      <td>
                        <strong>{pkg.title}</strong>
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>ID: {pkg.id} | supervisor: {pkg.academicSupervisor}</div>
                      </td>
                      <td>
                        <span style={{ display: 'block', fontSize: '0.8rem' }}>🖼️ Poster: {pkg.poster ? '✅ Yes' : '❌ No'}</span>
                        <span style={{ display: 'block', fontSize: '0.8rem' }}>📄 PDF: {pkg.posterPdf ? '✅ Yes' : '❌ No'}</span>
                        <span style={{ display: 'block', fontSize: '0.8rem' }}>📁 Files: {pkg.files ? pkg.files.join(', ') : 'None'}</span>
                      </td>
                      <td>
                        <span className={`status-pill ${pkg.validation.status === 'Valid' ? 'approved' : pkg.validation.status === 'Warning' ? 'awaiting_ocr' : 'archived'}`}>
                          {pkg.validation.status}
                        </span>
                      </td>
                      <td>
                        {pkg.validation.status === 'Error' ? (
                          <div style={{ color: 'var(--danger)', fontSize: '0.8rem', fontWeight: 'bold' }}>Blocked from Import</div>
                        ) : projects.some(p => p.id === pkg.id || p.sourceFolder === pkg.sourceFolder || p.sampleImportId === pkg.sampleImportId) ? (
                          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 'bold' }}>Already Imported</div>
                        ) : (
                          <div style={{ color: 'var(--success)', fontSize: '0.8rem', fontWeight: 'bold' }}>Ready: Map as In-Review</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ background: 'white', borderRadius: '12px', border: '1px solid var(--border)', padding: '1rem' }}>
              <h5 style={{ color: 'var(--primary)', marginBottom: '0.5rem' }}>Pre-flight Validation Console Logs</h5>
              <div style={{ background: '#0f172a', color: '#38bdf8', padding: '1rem', borderRadius: '8px', fontFamily: 'monospace', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '200px', overflowY: 'auto' }}>
                {importPackages.map(pkg => (
                  <div key={pkg.id} style={{ borderBottom: '1px solid #334155', paddingBottom: '0.5rem' }}>
                    <span style={{ color: '#e2e8f0', fontWeight: 'bold' }}>[Package {pkg.id}] {pkg.title}</span>
                    {pkg.validation.errors.map((err, i) => (
                      <div key={i} style={{ color: '#f87171', paddingLeft: '1rem' }}>✖ [ERROR] {err}</div>
                    ))}
                    {pkg.validation.warnings.map((warn, i) => (
                      <div key={i} style={{ color: '#fbbf24', paddingLeft: '1rem' }}>⚠ [WARNING] {warn}</div>
                    ))}
                    {pkg.validation.errors.length === 0 && pkg.validation.warnings.length === 0 && (
                      <div style={{ color: '#4ade80', paddingLeft: '1rem' }}>✓ [SUCCESS] All layout structures and URLs fully compliant.</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    );
  };

  const renderPublicPreview = () => {
    const published = projects.filter(p => p.status === 'published' || p.status === 'approved');
    const years = [...new Set(published.map(p => p.year))].sort((a, b) => b - a);

    return (
      <section className="public-preview">
        <div className="duda-header">
          <h1>Capstone Impact Showcase</h1>
          <p>Explore the innovative projects from our graduating students.</p>
        </div>

        {years.map(year => (
          <div key={year} className="year-section">
            <h2 className="year-heading">{year}</h2>
            <div className="duda-grid">
              {published.filter(p => p.year === year).map(p => (
                <div key={p.id} className="duda-card">
                  <div className="card-image" style={{ cursor: 'pointer' }} onClick={() => { setPreviewProject(p); setCameFromEdit(false); setView('detail'); }}>
                    <img src={p.poster || 'https://via.placeholder.com/400x600?text=No+Poster'} alt={p.imageAlt || p.title} />
                  </div>
                  <div className="card-content">
                    <span className="card-discipline">{p.discipline}</span>
                    <h3>{p.title}</h3>
                    <p className="card-summary">{p.summary}</p>
                    <button className="btn-learn-more" onClick={() => { setPreviewProject(p); setCameFromEdit(false); setView('detail'); }}>Learn More</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    );
  };

  const renderProjectDetail = () => {
    if (!previewProject || typeof previewProject !== 'object') {
      return (
        <div className="error-fallback" id="project-detail" style={{ padding: '4rem', textAlign: 'center', background: '#0f172a', borderRadius: '12px', color: 'white', maxWidth: '800px', margin: '2rem auto' }}>
          <h2 style={{ marginBottom: '1.5rem' }}>Project not found or could not be loaded.</h2>
          <button className="btn-primary" onClick={() => setView('public')}>Return to Showcase</button>
        </div>
      );
    }

    const defaultOrder = ["background", "solution", "snapshots", "video", "links"];
    const layoutConfig = previewProject.layoutConfig || {};
    const validTemplates = ["poster_showcase", "technical_detail", "media_rich"];
    const templateId = validTemplates.includes(layoutConfig.templateId) ? layoutConfig.templateId : "poster_showcase";
    const featuredMedia = layoutConfig.featuredMedia || "poster";

    // Normalize layoutConfig safely
    const sectionOrder = Array.isArray(layoutConfig.sectionOrder) ? layoutConfig.sectionOrder : defaultOrder;
    const hiddenSections = Array.isArray(layoutConfig.hiddenSections) ? layoutConfig.hiddenSections : [];

    // Normalize optional arrays safely
    const snapshots = Array.isArray(previewProject.snapshots) ? previewProject.snapshots : [];
    const extLinks = Array.isArray(previewProject.externalLinks) ? previewProject.externalLinks : [];

    const posterAlt = previewProject.accessibilityText || previewProject.imageAlt || previewProject.title || "Project Poster";

    // ----------------------------------------------------
    // HELPER FUNCTIONS (Declared first to avoid TDZ Errors)
    // ----------------------------------------------------
    function embedUrl(url) {
      if (!url) return "";
      if (url.includes("youtube.com") || url.includes("youtu.be")) {
          const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/);
          if (match && match[2] && match[2].length === 11) return `https://www.youtube.com/embed/${match[2]}`;
      }
      return url;
    }

    function renderVideoFrame(url) {
        const src = embedUrl(url);
        if (!src) return null;
        return (
          <div className="cip-video-frame">
            <iframe src={src} title="Project Video" frameBorder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen></iframe>
          </div>
        );
    }

    function renderSnapshotGrid(limit = 0, hero = false) {
        const selected = limit > 0 ? snapshots.slice(0, limit) : snapshots;
        if (selected.length === 0) return null;
        return (
          <div className={`snapshot-grid ${hero ? "snapshot-hero-grid" : ""}`}>
            {selected.map((url, idx) => (
              <button className="snapshot-card" type="button" key={idx} onClick={() => setLightboxIndex(idx)} aria-label={`Open snapshot ${idx + 1}`}>
                <span className="snapshot-inner">
                  <img src={url} alt={`Snapshot ${idx + 1}`} loading="lazy" />
                </span>
              </button>
            ))}
          </div>
        );
    }

    function getElevatedMedia() {
        if (featuredMedia === "none") return "none";

        const canShowVideo = !!(previewProject.videoUrl && !hiddenSections.includes("video"));
        const canShowSnapshots = !!(snapshots.length > 0 && !hiddenSections.includes("snapshots"));
        const canShowPoster = !!(previewProject.poster && !hiddenSections.includes("poster"));

        if (featuredMedia === "video" && canShowVideo) return "video";
        if ((featuredMedia === "gallery" || featuredMedia === "snapshots") && canShowSnapshots) return "snapshots";
        if (featuredMedia === "poster" && canShowPoster) return "poster";

        // Fallback order: video -> snapshots/gallery -> poster
        if (canShowVideo) return "video";
        if (canShowSnapshots) return "snapshots";
        if (canShowPoster) return "poster";

        // Unavoidable fallback if poster exists and absolutely nothing else is available
        if (previewProject.poster && !canShowVideo && !canShowSnapshots) {
            return "poster";
        }

        return "none";
    }

    function renderSnapshotStrip() {
        const activeMedia = getElevatedMedia();
        if (hiddenSections.includes("snapshots") || snapshots.length === 0 || activeMedia === "snapshots") return null;
        return (
          <div className="exhibition-strip">
            <div>
              {snapshots.map((url, idx) => (
                <button type="button" key={idx} onClick={() => setLightboxIndex(idx)} aria-label={`Open snapshot ${idx + 1}`}>
                  <img src={url} alt={`Snapshot ${idx + 1}`} loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        );
    }

    const chipValues = [
        previewProject.program,
        previewProject.year ? `Class of ${previewProject.year}` : "",
        Array.isArray(previewProject.disciplines) ? previewProject.disciplines.join(", ") : (previewProject.discipline || ""),
        previewProject.industryPartner,
        previewProject.academicSupervisor ? `Supervisor: ${previewProject.academicSupervisor}` : ""
    ].filter(Boolean);

    function renderMetadataChips(light = false) {
        if (hiddenSections.includes("metadata")) return null;
        return (
          <div className={`metadata-chips ${light ? "chips-light" : ""}`}>
            {chipValues.map((value, idx) => (
              <span key={idx}>{value}</span>
            ))}
          </div>
        );
    }

    function renderMetadata(light = false) {
        if (hiddenSections.includes("metadata")) return null;
        const items = [
            ["Academic Supervisor", previewProject.academicSupervisor || "N/A"],
            ["Industry Partner", previewProject.industryPartner || "N/A"],
            ["Disciplines", Array.isArray(previewProject.disciplines) ? previewProject.disciplines.join(", ") : (previewProject.disciplines || previewProject.discipline || "N/A")],
            ["Program", previewProject.program || "N/A"],
            ["Year", previewProject.year || "N/A"]
        ];
        return (
          <dl className={`metadata-list ${light ? "metadata-light" : "metadata-dark"}`}>
            {items.map(([label, value], idx) => (
              <div key={idx}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        );
    }

    function renderLinks(large = false) {
        const showPosterPdf = previewProject.posterPdf && !hiddenSections.includes("posterPdf");
        const showPosterImgLink = !showPosterPdf && previewProject.poster && !hiddenSections.includes("poster");

        const showExternal = !hiddenSections.includes("externalLinks") && !hiddenSections.includes("links");

        const hasExternal = showExternal && (previewProject.demoUrl || previewProject.repositoryUrl || extLinks.length > 0);
        const hasPosterAction = showPosterPdf || showPosterImgLink;

        if (!hasExternal && !hasPosterAction) return null;

        return (
          <div className={`cip-links ${large ? "cip-links-large" : ""}`}>
            {showExternal && previewProject.demoUrl && <a href={previewProject.demoUrl} target="_blank" rel="noopener noreferrer" className="btn-cta btn-cta-demo">Open Live Demo</a>}
            {showExternal && previewProject.repositoryUrl && <a href={previewProject.repositoryUrl} target="_blank" rel="noopener noreferrer" className="btn-cta btn-cta-code">View Code Repository</a>}
            {showExternal && extLinks.map((lnk, idx) => (
              <a key={idx} href={lnk.url} target="_blank" rel="noopener noreferrer" className="btn-cta btn-cta-link">{lnk.label || "Project Link"}</a>
            ))}
            {showPosterPdf && <a href={previewProject.posterPdf} target="_blank" rel="noopener noreferrer" className="btn-cta btn-cta-demo" style={{ background: '#dc2626', borderColor: '#dc2626', color: '#fff', fontWeight: 850 }}>Download Poster PDF</a>}
            {showPosterImgLink && <a href={previewProject.poster} target="_blank" rel="noopener noreferrer" className="btn-cta btn-cta-link" style={templateId === 'technical_detail' ? { background: '#fff', border: '1px solid #cbd5e1', color: '#0f172a', fontWeight: 850 } : { border: '1px solid rgba(255,255,255,0.45)', color: '#93c5fd', fontWeight: 850 }}>View Poster</a>}
          </div>
        );
    }

    function renderTeam(light = false) {
        if (hiddenSections.includes("team")) return null;
        const members = Array.isArray(previewProject.teamMembers) ? previewProject.teamMembers : String(previewProject.teamMembers || "").split(",").filter(Boolean);
        return (
          <section className="detail-section team-section">
            <h3 className="section-title">The Team</h3>
            <div className={`team-container ${light ? "team-light" : ""}`}>
              {previewProject.groupName && <p className="group-name">Group: {previewProject.groupName}</p>}
              <ul className="team-chips">
                {members.map((m, idx) => (
                  <li key={idx}>{String(m).trim()}</li>
                ))}
              </ul>
            </div>
          </section>
        );
    }

    function renderCitations(light = false) {
        if (hiddenSections.includes("citations")) return null;
        const cites = Array.isArray(previewProject.citations) ? previewProject.citations : (previewProject.citations ? [previewProject.citations] : []);
        if (cites.length === 0) return null;
        return (
          <section className="detail-section citations-section">
            <h3 className="section-title">Citations</h3>
            <div className={`team-container ${light ? "team-light" : ""}`} style={{ padding: '1.5rem', borderRadius: '16px' }}>
              <ul style={{ paddingLeft: '1.25rem', margin: 0, lineHeight: 1.75, color: light ? "#334155" : "#cbd5e1" }}>
                {cites.map((c, idx) => (
                  <li key={idx}>{c}</li>
                ))}
              </ul>
            </div>
          </section>
        );
    }

    function isHidden(sec) {
        if (hiddenSections.includes(sec)) return true;
        if (sec === 'links' && hiddenSections.includes('externalLinks')) return true;
        if (sec === 'externalLinks' && hiddenSections.includes('links')) return true;
        return false;
    }

    function shouldShow(sec) {
        if (isHidden(sec)) return false;
        if (sec === 'summary') return !!previewProject.summary;
        if (sec === 'background') return !!previewProject.background;
        if (sec === 'solution') return !!previewProject.solution;
        if (sec === 'poster') return !!previewProject.poster;
        if (sec === 'posterPdf') return !!previewProject.posterPdf;
        if (sec === 'snapshots') return snapshots.length > 0;
        if (sec === 'video') return !!previewProject.videoUrl;
        if (sec === 'links' || sec === 'externalLinks') {
            const showPosterPdf = !!(previewProject.posterPdf && !hiddenSections.includes("posterPdf"));
            const showPosterImgLink = !!(!showPosterPdf && previewProject.poster && !hiddenSections.includes("poster"));
            const showExternal = !hiddenSections.includes("externalLinks") && !hiddenSections.includes("links");
            const hasExternal = showExternal && (previewProject.demoUrl || previewProject.repositoryUrl || extLinks.length > 0);
            return !!(hasExternal || showPosterPdf || showPosterImgLink);
        }
        if (sec === 'accessibilityText') return !!previewProject.accessibilityText;
        if (sec === 'team') return !!(previewProject.teamMembers && (Array.isArray(previewProject.teamMembers) ? previewProject.teamMembers.length > 0 : String(previewProject.teamMembers).trim() !== ''));
        if (sec === 'metadata') return true;
        if (sec === 'citations') {
            const cites = Array.isArray(previewProject.citations) ? previewProject.citations : (previewProject.citations ? [previewProject.citations] : []);
            return cites.length > 0;
        }
        return false;
    }

    const sectionLabels = {
        background: "Background",
        solution: "Solution",
        snapshots: "Project Snapshots",
        video: "Project Video",
        links: "Resources",
        externalLinks: "Resources",
        accessibilityText: "Accessibility Text",
        metadata: "Specifications",
        citations: "Citations"
    };

    function renderSection(sec, numbered = false) {
        if (!shouldShow(sec)) return null;

        let content = null;
        if (sec === "background") {
            content = <p className="section-text">{previewProject.background}</p>;
        } else if (sec === "solution") {
            content = <p className="section-text">{previewProject.solution}</p>;
        } else if (sec === "snapshots") {
            const activeMedia = getElevatedMedia();
            if (activeMedia === "snapshots" && templateId === "media_rich") return null;
            content = renderSnapshotGrid();
        } else if (sec === "video") {
            const activeMedia = getElevatedMedia();
            if (activeMedia === "video" && templateId === "media_rich") return null;
            content = renderVideoFrame(previewProject.videoUrl);
        } else if (sec === "links" || sec === "externalLinks") {
            content = renderLinks(false);
        } else if (sec === "accessibilityText") {
            content = <p className="section-text">{previewProject.accessibilityText}</p>;
        } else if (sec === "team") {
            return renderTeam(templateId === "technical_detail");
        } else if (sec === "metadata") {
            if (templateId === "technical_detail" || templateId === "media_rich") return null;
            content = (
              <div className="team-container" style={{ padding: '1.5rem', borderRadius: '16px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)' }}>
                {renderMetadata(false)}
              </div>
            );
        } else if (sec === "citations") {
            const cites = Array.isArray(previewProject.citations) ? previewProject.citations : (previewProject.citations ? [previewProject.citations] : []);
            if (cites.length === 0) return null;
            content = (
              <div className={`team-container ${templateId === "technical_detail" ? "team-light" : ""}`} style={{ padding: '1.5rem', borderRadius: '16px' }}>
                <ul style={{ paddingLeft: '1.25rem', margin: 0, lineHeight: 1.75, color: templateId === "technical_detail" ? "#334155" : "#cbd5e1" }}>
                  {cites.map((c, idx) => (
                    <li key={idx}>{c}</li>
                  ))}
                </ul>
              </div>
            );
        }

        if (!content) return null;

        const sectionIndex = tocSections.indexOf(sec) + 1;
        const label = sectionLabels[sec] || sec;

        return (
          <section key={sec} className={`detail-section ${numbered ? "report-row" : ""}`}>
            {numbered && sectionIndex > 0 && (
              <span className="report-number">{sectionIndex}</span>
            )}
            <div>
              <h3 className="section-title">{label}</h3>
              {content}
            </div>
          </section>
        );
    }

    // ----------------------------------------------------
    // IMMEDIATE VALUES COMPUTATION (Evaluated safely after helpers)
    // ----------------------------------------------------
    const activeMedia = getElevatedMedia();

    const consumedSections = [];
    if (activeMedia === "video") consumedSections.push("video");
    if (activeMedia === "snapshots") consumedSections.push("snapshots");
    if (activeMedia === "poster") consumedSections.push("poster");
    if (templateId === "poster_showcase" && snapshots.length > 0 && !hiddenSections.includes("snapshots")) {
        consumedSections.push("snapshots");
    }

    // Construct full sections order to render in body, respecting sectionOrder and appending rest
    const allPossibleSections = ["summary", "background", "solution", "poster", "posterPdf", "snapshots", "video", "links", "externalLinks", "accessibilityText", "team", "metadata", "citations"];
    const fullOrder = [...sectionOrder];
    allPossibleSections.forEach(sec => {
        if (!fullOrder.includes(sec)) {
            if (sec === 'links' && fullOrder.includes('externalLinks')) return;
            if (sec === 'externalLinks' && fullOrder.includes('links')) return;
            fullOrder.push(sec);
        }
    });

    const bodySections = fullOrder.filter(sec => {
        if (sec === "summary") return false;
        if (sec === "poster" || sec === "posterPdf") return false;
        if (sec === "metadata" && (templateId === "technical_detail" || templateId === "media_rich")) return false;
        if (consumedSections.includes(sec)) return false;
        return true;
    });

    const numberedKeys = ["background", "solution", "links", "externalLinks", "snapshots", "video", "citations"];
    const activeNumberedSections = [];
    bodySections.forEach(sec => {
        if (numberedKeys.includes(sec) && shouldShow(sec)) {
            const isLinkSec = sec === "links" || sec === "externalLinks";
            if (isLinkSec && activeNumberedSections.some(s => s === "links" || s === "externalLinks")) {
                return;
            }
            activeNumberedSections.push(sec);
        }
    });
    const tocSections = activeNumberedSections;

    const baseStyles = `
        #project-detail .cip-module, #project-detail .cip-module * { box-sizing: border-box; }
        #project-detail .cip-module { max-width: 1240px; margin: 0 auto; text-align: left; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
        #project-detail .cip-back { display: inline-flex; padding: .65rem 1rem; border-radius: 8px; font-weight: 750; cursor: pointer; text-decoration: none; border: 0; outline: none; }
        #project-detail .section-title { margin: 2.5rem 0 1rem; padding-bottom: .55rem; font-size: 1.45rem; font-weight: 800; letter-spacing: 0; }
        #project-detail .section-text { margin: 0 0 1.5rem; line-height: 1.75; font-size: 1.05rem; }
        #project-detail .metadata-chips { display: flex; flex-wrap: wrap; gap: .65rem; margin: 1.35rem 0 1.8rem; }
        #project-detail .metadata-chips span { padding: .45rem .8rem; border-radius: 999px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.15); color: #f8fafc; font-weight: 750; font-size: .85rem; }
        #project-detail .metadata-chips.chips-light span { background:#f8fafc; border-color:#d8d1c4; color:#1f2937; }
        #project-detail .metadata-list { display:grid; gap:1rem; margin:0; }
        #project-detail .metadata-list dt { margin:0 0 .3rem; font-size:.72rem; text-transform:uppercase; letter-spacing:.12em; font-weight:900; }
        #project-detail .metadata-list dd { margin:0; line-height:1.45; font-weight:650; }
        #project-detail .metadata-dark dt { color:#9fb2ca; } #project-detail .metadata-dark dd { color:#fff; }
        #project-detail .metadata-light dt { color:#64748b; } #project-detail .metadata-light dd { color:#0f172a; }
        #project-detail .snapshot-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:1rem; }
        #project-detail .snapshot-card { padding:0; border:1px solid rgba(148,163,184,.35); border-radius:12px; overflow:hidden; background:#020617; cursor:pointer; width:100%; display:block; text-align:left; }
        #project-detail .snapshot-inner { display:block; aspect-ratio:16/10; overflow:hidden; }
        #project-detail .snapshot-inner img { width:100%; height:100%; object-fit:cover; display:block; }
        #project-detail .cip-video-frame { position:relative; padding-bottom:56.25%; height:0; overflow:hidden; border-radius:16px; background:#000; }
        #project-detail .cip-video-frame iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
        #project-detail .cip-links { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,max-content)); gap:.85rem; margin-top:1rem; }
        #project-detail .cip-links-large { grid-template-columns:1fr; }
        #project-detail .btn-cta { min-height:44px; padding:.8rem 1rem; border-radius:10px; display:inline-flex; align-items:center; justify-content:center; text-align:center; text-decoration:none !important; font-weight:850; cursor: pointer; }
        #project-detail .cip-links-large .btn-cta { min-height:58px; padding:1rem 1.2rem; border-radius:14px; }
        #project-detail .team-container { padding:1.5rem; border-radius:16px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.09); }
        #project-detail .team-container.team-light { background:#f8fafc; border-color:#d8d1c4; }
        #project-detail .group-name { margin:0 0 1rem; font-weight:750; }
        #project-detail .team-chips { display:flex; flex-wrap:wrap; gap:.65rem; padding:0; margin:0; list-style:none; }
        #project-detail .team-chips li { padding:.5rem .75rem; border-radius:999px; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); color:#f8fafc; font-weight:700; }
        #project-detail .team-light .team-chips li { background:#fff; border-color:#cbd5e1; color:#334155; }
        @media (max-width: 860px) { #project-detail .cip-module { padding:2rem 1.25rem !important; border-radius:18px !important; } #project-detail .poster-wall, #project-detail .report-grid, #project-detail .media-grid { grid-template-columns:1fr !important; } #project-detail .detail-sidebar, #project-detail .hero-right-col, #project-detail .technical-side-col { position:static !important; } }
    `;

    const lightbox = lightboxIndex >= 0 && snapshots[lightboxIndex] && (
      <div className="lightbox-overlay" onClick={() => setLightboxIndex(-1)}>
        <div className="lightbox-container" onClick={e => e.stopPropagation()}>
          <button className="lightbox-close-btn" onClick={() => setLightboxIndex(-1)}>X</button>
          <div className="lightbox-image-wrapper"><img src={snapshots[lightboxIndex]} alt="Full size snapshot" /></div>
        </div>
      </div>
    );

    if (templateId === "technical_detail") {
      const toc = activeNumberedSections;

      let sidebarMedia = null;
      if (activeMedia === "video") {
          sidebarMedia = <div style={{ marginTop: '1.5rem' }}>{renderVideoFrame(previewProject.videoUrl)}</div>;
      } else if (activeMedia === "snapshots") {
          sidebarMedia = <div style={{ marginTop: '1.5rem' }}>{renderSnapshotGrid(1)}</div>;
      } else if (activeMedia === "poster") {
          const showPdfButton = previewProject.posterPdf && !hiddenSections.includes("posterPdf");
          sidebarMedia = (
            <div style={{ marginTop: '1.5rem', maxWidth: '220px', marginLeft: 'auto', marginRight: 'auto', background: '#fff', border: '1px solid #d8d1c4', borderRadius: '8px', padding: '.8rem', textAlign: 'center' }}>
                <p style={{ margin: '0 0 .75rem', color: '#64748b', fontSize: '.75rem', fontWeight: 800, textTransform: 'uppercase' }}>Appendix Poster</p>
                <img src={previewProject.poster} alt={posterAlt} style={{ width: '100%', borderRadius: '6px', border: '1px solid #cbd5e1' }} />
                {showPdfButton && (
                  <a href={previewProject.posterPdf} target="_blank" rel="noopener noreferrer" style={{ marginTop: '1rem', padding: '.75rem', fontSize: '.82rem', background: '#0f766e', color: '#fff', borderRadius: '6px', display: 'flex', justifyContent: 'center', textDecoration: 'none', fontWeight: 800, fontFamily: 'system-ui,-apple-system,sans-serif' }}>Download Poster PDF</a>
                )}
            </div>
          );
      }

      return (
        <div id="project-detail" style={{ width: '100%' }}>
          <div className="cip-module layout-preset-technical_detail" style={{ background: '#f7f4ef', color: '#1f2937', borderRadius: '10px', padding: '2rem', border: '1px solid #d8d1c4', boxShadow: '0 18px 45px rgba(31,41,55,.12)', fontFamily: "Georgia, Cambria, 'Times New Roman', serif" }}>
            <style dangerouslySetInnerHTML={{ __html: baseStyles }} />
            <style dangerouslySetInnerHTML={{ __html: `
              #project-detail .layout-preset-technical_detail .section-title{color:#0f172a!important;border-bottom:1px solid #d8d1c4;font-family:Georgia, Cambria, 'Times New Roman', serif;font-size:1.35rem}
              #project-detail .layout-preset-technical_detail .section-text{color:#243044!important;font-size:1.08rem!important;line-height:1.9!important}
              #project-detail .layout-preset-technical_detail .btn-cta-demo{background:#0f766e;color:#fff!important}
              #project-detail .layout-preset-technical_detail .btn-cta-code,#project-detail .layout-preset-technical_detail .btn-cta-link{background:#fff;color:#0f172a!important;border:1px solid #cbd5e1}
              .report-row{display:grid;grid-template-columns:3rem 1fr;gap:1rem}
              .report-number{margin-top:2.45rem;color:#0f766e;font-weight:900;font-size:1.15rem}
              #project-detail .layout-preset-technical_detail .team-container.team-light { background: #f1ebd9 !important; border: 1px solid #cfc6b8 !important; color: #0f172a !important; }
              #project-detail .layout-preset-technical_detail .team-light .group-name { color: #0f172a !important; }
              #project-detail .layout-preset-technical_detail .team-light .team-chips li { background: #fff !important; border-color: #cfc6b8 !important; color: #0f172a !important; }
              #project-detail .layout-preset-technical_detail .metadata-chips.chips-light span { background: #f1ebd9 !important; border-color: #cfc6b8 !important; color: #0f172a !important; }
              #project-detail .layout-preset-technical_detail .metadata-light dt { color: #475569 !important; }
              #project-detail .layout-preset-technical_detail .metadata-light dd { color: #0f172a !important; }
              #project-detail .layout-preset-technical_detail .technical-side-col ol { color: #0f172a !important; }
              #project-detail .layout-preset-technical_detail .technical-side-col ol li { color: #0f172a !important; }
              #project-detail .layout-preset-technical_detail .citations-section .team-container.team-light { background: #f1ebd9 !important; border: 1px solid #cfc6b8 !important; color: #0f172a !important; }
              #project-detail .layout-preset-technical_detail .citations-section ul li { color: #0f172a !important; }
            `}} />
            <div style={{ background: '#fffdf8', border: '1px solid #e4dccf', borderRadius: '8px', padding: '2.5rem', boxShadow: '0 8px 24px rgba(31,41,55,.06)' }}>
              <button className="cip-back" type="button" onClick={() => setView(cameFromEdit ? 'edit' : 'public')} style={{ background: '#f3eee5', color: '#0f172a', border: '1px solid #cfc6b8', borderRadius: '4px' }}>{cameFromEdit ? 'Back to Workspace' : 'Back to Showcase'}</button>
              <header style={{ borderBottom: '3px double #cfc6b8', paddingBottom: '2rem', margin: '2rem 0 2.5rem' }}>
                <span style={{ background: '#0f766e', color: '#fff', padding: '.35rem .85rem', borderRadius: '3px', fontSize: '.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em', fontFamily: 'system-ui,-apple-system,sans-serif' }}>Formal Project Report</span>
                <h1 style={{ color: '#111827', fontSize: 'clamp(2rem, 4vw, 3rem)', lineHeight: '1.18', margin: '.9rem 0 .5rem', letterSpacing: '0' }}>{previewProject.title}</h1>
                {renderMetadataChips(true)}
                {shouldShow("summary") && (
                  <p style={{ margin: '1.5rem 0 0', color: '#334155', lineHeight: '1.8', fontSize: '1.12rem', borderLeft: '4px solid #0f766e', padding: '1.25rem 1.5rem', maxWidth: '82ch', background: '#f8fafc', borderRadius: '0 6px 6px 0' }}>{previewProject.summary}</p>
                )}
              </header>
              <div className="report-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.65fr) minmax(250px,.9fr)', gap: '3.5rem', alignItems: 'start' }}>
                <main>
                  {bodySections.map(sec => renderSection(sec, true))}
                </main>
                <aside className="technical-side-col" style={{ position: 'sticky', top: '2rem' }}>
                  {toc.length > 0 && (
                    <div style={{ background: '#f8fafc', border: '1px solid #d8d1c4', borderRadius: '8px', padding: '1.25rem', marginBottom: '1.5rem', fontFamily: 'system-ui,-apple-system,sans-serif' }}>
                      <h4 style={{ margin: '0 0 .85rem', color: '#0f172a', fontSize: '.85rem', textTransform: 'uppercase', letterSpacing: '.08em' }}>Contents</h4>
                      <ol style={{ margin: 0, paddingLeft: '1.25rem', color: '#334155', lineHeight: '1.9', fontWeight: 700 }}>
                        {toc.map(sec => <li key={sec}>{sectionLabels[sec] || sec}</li>)}
                      </ol>
                    </div>
                  )}
                  {shouldShow("metadata") && (
                    <div style={{ background: '#fff', padding: '1.5rem', borderRadius: '8px', border: '1px solid #d8d1c4', fontFamily: 'system-ui,-apple-system,sans-serif' }}>
                      <h4 style={{ marginTop: 0, borderBottom: '1px solid #e2e8f0', paddingBottom: '1rem', color: '#0f172a' }}>Report Metadata</h4>
                      {renderMetadata(true)}
                    </div>
                  )}
                  {sidebarMedia}
                </aside>
              </div>
            </div>
          </div>
          {lightbox}
        </div>
      );
    }

    if (templateId === "media_rich") {
      let mediaHero = null;
      if (activeMedia === "video") {
          mediaHero = renderVideoFrame(previewProject.videoUrl);
      } else if (activeMedia === "snapshots") {
          mediaHero = renderSnapshotGrid(3, true);
      } else if (activeMedia === "poster") {
          mediaHero = (
            <div style={{ textAlign: 'center' }}>
              <img src={previewProject.poster} alt={posterAlt} style={{ maxWidth: '100%', maxHeight: '540px', objectFit: 'contain', borderRadius: '16px', border: '1px solid rgba(96,165,250,.35)' }} />
            </div>
          );
      }

      const hasHeroMedia = activeMedia !== "none" && mediaHero;

      return (
        <div id="project-detail" style={{ width: '100%' }}>
          <div className="cip-module layout-preset-media_rich" style={{ background: '#020617', color: '#f8fafc', borderRadius: '24px', padding: '2.5rem', border: '1px solid rgba(96,165,250,.28)', boxShadow: '0 28px 58px rgba(2,6,23,.65)' }}>
            <style dangerouslySetInnerHTML={{ __html: baseStyles }} />
            <style dangerouslySetInnerHTML={{ __html: `
              #project-detail .layout-preset-media_rich .section-title{color:#fff!important;border-bottom:1px solid rgba(96,165,250,.25);font-size:1.45rem;font-weight:800;margin-top:2.5rem;margin-bottom:1rem;padding-bottom:.55rem}
              #project-detail .layout-preset-media_rich .section-text{color:#cbd5e1!important;font-size:1.05rem!important;line-height:1.75!important}
              .layout-preset-media_rich .btn-cta-demo{background:#2563eb;color:#fff!important;box-shadow:0 14px 28px rgba(37,99,235,.32)}
              .layout-preset-media_rich .btn-cta-code{background:#0f172a;color:#fff!important;border:1px solid rgba(96,165,250,.55)}
              .layout-preset-media_rich .btn-cta-link{background:rgba(255,255,255,.06);color:#dbeafe!important;border:1px solid rgba(255,255,255,.14)}
              .snapshot-hero-grid{grid-template-columns:2fr 1fr}
              .snapshot-hero-grid .snapshot-card:first-child{grid-row:span 2}
              .snapshot-hero-grid .snapshot-card:first-child .snapshot-inner{min-height:360px}
              .snapshot-hero-grid .snapshot-inner{min-height:175px}
            `}} />
            <button className="cip-back" type="button" onClick={() => setView(cameFromEdit ? 'edit' : 'public')} style={{ background: '#0f172a', color: '#93c5fd', border: '1px solid rgba(96,165,250,.45)' }}>{cameFromEdit ? 'Back to Workspace' : 'Back to Showcase'}</button>
            <header style={{ marginTop: '2rem' }}>
              <span style={{ background: '#2563eb', color: '#fff', padding: '.35rem .85rem', borderRadius: '4px', fontSize: '.75rem', fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.08em' }}>Demo and Media</span>
              <h1 style={{ color: '#fff', fontWeight: 850, fontSize: 'clamp(2.2rem, 5vw, 3.8rem)', lineHeight: 1.05, margin: '.9rem 0 1rem', letterSpacing: 0 }}>{previewProject.title}</h1>
              {renderMetadataChips(false)}
              {shouldShow("summary") && (
                <p style={{ color: '#cbd5e1', maxWidth: '85ch', lineHeight: '1.75', fontSize: '1.12rem', borderLeft: '4px solid #2563eb', paddingLeft: '1.3rem' }}>{previewProject.summary}</p>
              )}
            </header>
            {hasHeroMedia && (
              <section style={{ background: '#000', border: '1px solid rgba(96,165,250,.35)', borderRadius: '24px', padding: '1.25rem', margin: '2rem 0 2.5rem', boxShadow: '0 0 40px rgba(37,99,235,.18)' }}>
                {mediaHero}
              </section>
            )}
            {shouldShow("links") && (
              <section style={{ background: 'rgba(15,23,42,.92)', border: '1px solid rgba(96,165,250,.35)', borderRadius: '20px', padding: '1.5rem', marginBottom: '2.5rem' }}>
                <h2 style={{ margin: '0 0 1rem', color: '#93c5fd', fontSize: '1.25rem' }}>Project Launchpad</h2>
                {renderLinks(true)}
              </section>
            )}
            <div className="media-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(260px,1fr)', gap: '3rem', alignItems: 'start' }}>
              <main>
                {bodySections.map(sec => renderSection(sec))}
              </main>
              <aside className="detail-sidebar" style={{ position: 'sticky', top: '2rem' }}>
                {shouldShow("metadata") && (
                  <div style={{ background: 'rgba(15,23,42,.9)', border: '1px solid rgba(148,163,184,.16)', borderRadius: '18px', padding: '1.5rem' }}>
                    <h3 style={{ margin: '0 0 1rem', color: '#fff' }}>Quick Specifications</h3>
                    {renderMetadata(false)}
                  </div>
                )}
                {shouldShow("poster") && activeMedia !== "poster" && (
                  <div style={{ marginTop: '1.5rem', maxWidth: '230px', marginLeft: 'auto', marginRight: 'auto' }}>
                    <img src={previewProject.poster} alt={posterAlt} style={{ width: '100%', borderRadius: '10px', opacity: .88, border: '1px solid rgba(255,255,255,.12)' }} />
                  </div>
                )}
              </aside>
            </div>
          </div>
          {lightbox}
        </div>
      );
    }

    let heroMedia = null;
    if (activeMedia === "video") {
        heroMedia = renderVideoFrame(previewProject.videoUrl);
    } else if (activeMedia === "snapshots") {
        heroMedia = renderSnapshotGrid(3, true);
    } else if (activeMedia === "poster") {
        heroMedia = <img src={previewProject.poster} alt={posterAlt} style={{ display: 'block', width: '100%', maxHeight: '76vh', objectFit: 'contain', borderRadius: '10px' }} />;
    }

    const showPdfButton = previewProject.posterPdf && !hiddenSections.includes("posterPdf");
    const gridStyle = heroMedia ? { display: 'grid', gridTemplateColumns: 'minmax(360px,.95fr) minmax(0,1.05fr)', gap: '3rem', alignItems: 'center', marginTop: '2rem', minHeight: '62vh' } : { maxWidth: '800px', margin: '2rem auto', textAlign: 'center' };

    return (
      <div id="project-detail" style={{ width: '100%' }}>
        <div className="cip-module layout-preset-poster_showcase" style={{ background: '#14110f', color: '#f8fafc', borderRadius: '24px', padding: '2.5rem', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 24px 50px rgba(20,17,15,.5)' }}>
          <style dangerouslySetInnerHTML={{ __html: baseStyles }} />
          <style dangerouslySetInnerHTML={{ __html: `
            #project-detail .layout-preset-poster_showcase .section-title{color:#fff!important;border-bottom:1px solid rgba(255,255,255,.12);font-size:1.45rem;font-weight:800;margin-top:2.5rem;margin-bottom:1rem;padding-bottom:.55rem}
            #project-detail .layout-preset-poster_showcase .section-text{color:#ded6cc!important;font-size:1.05rem!important;line-height:1.75!important}
            .layout-preset-poster_showcase .btn-cta-demo,.poster-download{background:#dc2626;color:#fff!important;border:1px solid #dc2626}
            .layout-preset-poster_showcase .btn-cta-code,.layout-preset-poster_showcase .btn-cta-link{background:transparent;color:#fff!important;border:1px solid rgba(255,255,255,.22)}
            .exhibition-strip{margin-top:2rem;padding:1rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:18px;overflow-x:auto}
            .exhibition-strip>div{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(170px,250px);gap:1rem}
            .exhibition-strip button{padding:0;border:1px solid rgba(255,255,255,.16);border-radius:12px;overflow:hidden;background:#020617;cursor:pointer;width:100%;display:block;}
            .exhibition-strip img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block}
          `}} />
          <button className="cip-back" type="button" onClick={() => setView(cameFromEdit ? 'edit' : 'public')} style={{ background: '#2a211d', color: '#ffd7c2', border: '1px solid rgba(255,215,194,.35)' }}>{cameFromEdit ? 'Back to Workspace' : 'Back to Showcase'}</button>
          <div className="poster-wall" style={gridStyle}>
            {heroMedia && (
              <div style={{ order: 1, background: '#0b0908', border: '1px solid rgba(255,255,255,.14)', borderRadius: '18px', padding: '1rem', boxShadow: '0 30px 70px rgba(0,0,0,.58)' }}>
                {heroMedia}
              </div>
            )}
            <div style={{ order: 2 }}>
              <span style={{ background: '#b91c1c', color: '#fff', padding: '.35rem .85rem', borderRadius: '4px', fontSize: '.75rem', fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.08em' }}>Capstone Exhibition</span>
              <h1 style={{ color: '#fff', fontWeight: 900, fontSize: 'clamp(2rem, 5vw, 3.7rem)', lineHeight: 1.05, margin: '.9rem 0 1rem', letterSpacing: 0 }}>{previewProject.title}</h1>
              {renderMetadataChips(false)}
              {shouldShow("summary") && (
                <p style={{ color: '#ded6cc', lineHeight: '1.75', fontSize: '1.12rem', maxWidth: '66ch' }}>{previewProject.summary}</p>
              )}
              {showPdfButton && (
                <a href={previewProject.posterPdf} target="_blank" rel="noopener noreferrer" className="poster-download" style={{ marginTop: '1.5rem', minHeight: '56px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '1rem 1.35rem', borderRadius: '999px', textDecoration: 'none', fontWeight: 850 }}>Download Poster PDF</a>
              )}
            </div>
          </div>
          {renderSnapshotStrip()}
          <main style={{ maxWidth: '920px', margin: '3.5rem auto 0' }}>
            {bodySections.map(sec => renderSection(sec))}
          </main>
        </div>
        {lightbox}
      </div>
    );
  };

  return (
    <div className={`admin-app ${view === 'public' || view === 'detail' ? 'duda-mode' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo-placeholder">RI</div>
          <h2>Capstone Admin</h2>
        </div>
        <nav className="sidebar-nav">
          <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button>
          <button className={view === 'list' || view === 'edit' ? 'active' : ''} onClick={() => setView('list')}>Projects</button>
          <button className={view === 'import' ? 'active' : ''} onClick={() => setView('import')}>Import Projects</button>

          <div className="nav-separator">Public Distribution</div>
          <button onClick={() => window.open('https://showcase.rmit.edu.vn', '_blank')}>
            Official Duda Site (External)
          </button>

          <div className="nav-separator">Internal Staging</div>
          <button className={view === 'public' || view === 'detail' ? 'active' : ''} onClick={() => setView('public')}>
            Local Preview (Dev Only)
          </button>
        </nav>
        <div className="sidebar-footer" style={{ marginTop: 'auto', padding: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <label style={{ display: 'block', fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', marginBottom: '0.5rem' }}>STAGING ACCESS KEY</label>
          <input
            type="password"
            value={adminKey}
            onChange={(e) => {
              setAdminKey(e.target.value);
              localStorage.setItem('capstone_admin_key', e.target.value);
            }}
            style={{
              width: '100%',
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '4px',
              color: 'white',
              padding: '0.4rem',
              fontSize: '0.8rem'
            }}
            placeholder="Enter Key..."
          />
        </div>
      </aside>

      <div className="main-wrapper">
        {!(view === 'public' || view === 'detail') && (
          <header className="main-header">
            <div className="header-title">
              {view === 'dashboard' && 'CMS Dashboard'}
              {view === 'list' && 'Project Management'}
              {view === 'edit' && 'Review Project Metadata'}
              {view === 'import' && 'Project Import Workspace'}
            </div>
          </header>
        )}

        <div className="content-area">
          {message && <div className={`global-toast ${message.includes('Error') ? 'error' : 'success'}`}>{message}</div>}

          {view === 'dashboard' && renderDashboard()}
          {view === 'list' && renderProjectList()}
          {view === 'edit' && renderProjectForm()}
          {view === 'import' && renderBatchImport()}
          {view === 'public' && renderPublicPreview()}
          {view === 'detail' && renderProjectDetail()}
        </div>
      </div>
    </div>
  );
}

export default App;
