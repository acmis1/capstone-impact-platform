import React, { useState, useEffect } from 'react';
import './styles.css';

const API_URL = 'http://localhost:5000/api';

function App() {
  const [projects, setProjects] = useState([]);
  const [view, setView] = useState('dashboard'); // dashboard, list, edit, public, detail
  const [currentProject, setCurrentProject] = useState(null);
  const [previewProject, setPreviewProject] = useState(null);
  const [feedStatus, setFeedStatus] = useState({ exists: false });
  const [cloudStatus, setCloudStatus] = useState(null);
  const [cloudUrl, setCloudUrl] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);

  useEffect(() => {
    fetchProjects();
    fetchFeedStatus();
  }, []);

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

  const handlePublishCloud = async () => {
    setCloudStatus({ type: 'info', message: 'Publishing to cloud...' });
    try {
      const res = await fetch(`${API_URL}/publish-cloud-feed`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setCloudStatus({ type: 'success', message: `Published successfully! ${data.count} records.` });
        setCloudUrl(data.publicUrl);
        fetchFeedStatus();
      } else {
        setCloudStatus({ type: 'error', message: data.error || 'Cloud publishing failed.' });
      }
    } catch (err) {
      setCloudStatus({ type: 'error', message: 'Network error while publishing.' });
    }
  };

  const handleEdit = (project) => {
    // Convert arrays to comma strings for editing
    const editProject = {
      ...project,
      disciplines: Array.isArray(project.disciplines) ? project.disciplines.join(', ') : project.disciplines || '',
      teamMembers: Array.isArray(project.teamMembers) ? project.teamMembers.join(', ') : project.teamMembers || '',
      citations: Array.isArray(project.citations) ? project.citations.join(', ') : project.citations || '',
      snapshots: Array.isArray(project.snapshots) ? project.snapshots.join(', ') : project.snapshots || ''
    };
    setCurrentProject(editProject);
    setView('edit');
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    // Convert comma strings back to arrays
    const projectToSave = {
      ...currentProject,
      disciplines: typeof currentProject.disciplines === 'string' ? currentProject.disciplines.split(',').map(s => s.trim()).filter(s => s !== '') : currentProject.disciplines,
      teamMembers: typeof currentProject.teamMembers === 'string' ? currentProject.teamMembers.split(',').map(s => s.trim()).filter(s => s !== '') : currentProject.teamMembers,
      citations: typeof currentProject.citations === 'string' ? currentProject.citations.split(',').map(s => s.trim()).filter(s => s !== '') : currentProject.citations,
      snapshots: typeof currentProject.snapshots === 'string' ? currentProject.snapshots.split(',').map(s => s.trim()).filter(s => s !== '') : currentProject.snapshots,
    };

    const method = projectToSave.id ? 'PUT' : 'POST';
    const url = projectToSave.id ? `${API_URL}/projects/${projectToSave.id}` : `${API_URL}/projects`;

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectToSave),
      });
      if (res.ok) {
        setMessage('Project saved successfully!');
        fetchProjects();
        setTimeout(() => {
          setView('list');
          setMessage(null);
        }, 1500);
      }
    } catch (err) {
      console.error('Error saving project:', err);
      setMessage('Error saving project.');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateFeed = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/generate-feed`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setMessage(`Success: Feed generated with ${data.count} projects at ${data.path}`);
        fetchFeedStatus();
        setTimeout(() => setMessage(null), 5000);
      }
    } catch (err) {
      console.error('Error generating feed:', err);
      setMessage('Error generating feed.');
    } finally {
      setLoading(false);
    }
  };

  const getStatusCount = (status) => projects.filter(p => p.status === status).length;

  const renderDashboard = () => (
    <section className="dashboard">
      <div className="section-header">
        <h2>System Overview</h2>
        <p className="subtitle">Hybrid Architecture: Admin/CMS to Stable JSON Feed</p>
      </div>
      
      <div className="stats-grid">
        <div className="stat-card">
          <label>Total Records</label>
          <div className="stat-val">{projects.length}</div>
        </div>
        <div className="stat-card border-draft">
          <label>Draft</label>
          <div className="stat-val">{getStatusCount('draft')}</div>
        </div>
        <div className="stat-card border-pending">
          <label>Pending Review</label>
          <div className="stat-val">{getStatusCount('pending_review')}</div>
        </div>
        <div className="stat-card border-approved">
          <label>Approved</label>
          <div className="stat-val">{getStatusCount('approved')}</div>
        </div>
        <div className="stat-card border-published">
          <label>Published</label>
          <div className="stat-val">{getStatusCount('published')}</div>
        </div>
      </div>

      <div className="feed-status-container">
        <div className="feed-status-card">
          <h3>Stable Feed Status</h3>
          {feedStatus?.exists ? (
            <div className="feed-info">
              <div className="info-row"><span>Feed URL:</span> <code>/capstones-latest.json</code></div>
              <div className="info-row"><span>Public Records:</span> <span className="highlight">{feedStatus.count}</span></div>
              <div className="info-row"><span>Last Updated:</span> {new Date(feedStatus.lastUpdated).toLocaleString()}</div>
              <div className="info-note">Only 'approved' and 'published' records are exported.</div>
            </div>
          ) : (
            <p>Feed has not been generated yet.</p>
          )}
          <button onClick={handleGenerateFeed} className="btn-primary">
            Sync Local Feed
          </button>
          <button onClick={handlePublishCloud} className="btn-secondary" style={{ marginLeft: '10px' }}>
            Publish to Stable URL
          </button>
        </div>
            
        {cloudStatus && (
          <div className={`badge badge-${cloudStatus.type}`} style={{ marginTop: '10px', display: 'block' }}>
            {cloudStatus.message}
          </div>
        )}

        {cloudUrl ? (
          <div style={{ marginTop: '10px', fontSize: '0.85rem' }}>
            <strong>Cloud Feed URL:</strong> <a href={cloudUrl} target="_blank" rel="noreferrer" style={{ color: '#60a5fa' }}>{cloudUrl}</a>
            <p style={{ color: '#94a3b8', marginTop: '5px' }}>
              <em>Note: Set this URL in Duda's bodyend.html script once.</em>
            </p>
          </div>
        ) : (
          <div style={{ marginTop: '10px', fontSize: '0.85rem' }}>
            <strong>Cloud Sync:</strong> <span className="badge badge-warning">Not Configured</span>
            <p style={{ color: '#94a3b8', marginTop: '5px' }}>
              <em>Set SUPABASE_URL in .env to enable cloud publishing.</em>
            </p>
          </div>
        )}
      </div>
    </section>
  );

  const renderProjectList = () => (
    <section className="project-list">
      <div className="section-header">
        <h2>Project Repository</h2>
        <button className="btn-success" onClick={() => { setCurrentProject({ status: 'draft' }); setView('edit'); }}>+ Add New Project</button>
      </div>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Year</th>
              <th>Program</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.map(p => (
              <tr key={p.id}>
                <td><strong>{p.title}</strong></td>
                <td>{p.year}</td>
                <td>{p.program}</td>
                <td><span className={`status-pill ${p.status}`}>{p.status.replace('_', ' ')}</span></td>
                <td>
                  <button className="btn-outline" onClick={() => handleEdit(p)}>Edit & Review</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  const renderProjectForm = () => (
    <section className="project-form">
      <div className="section-header">
        <h2>{currentProject.id ? 'Edit & Review Project' : 'New Project Entry'}</h2>
        <p className="subtitle">ID: {currentProject.id || 'Pending'}</p>
      </div>
      <form onSubmit={handleSave}>
        <div className="form-section">
          <h3>Basic Identification</h3>
          <div className="form-grid">
            <div className="form-group full-width">
              <label>Project Title*</label>
              <input type="text" value={currentProject.title || ''} onChange={e => setCurrentProject({...currentProject, title: e.target.value})} required />
            </div>
            <div className="form-group">
              <label>Group Name</label>
              <input type="text" value={currentProject.groupName || ''} onChange={e => setCurrentProject({...currentProject, groupName: e.target.value})} />
            </div>
            <div className="form-group">
              <label>Year*</label>
              <input type="text" value={currentProject.year || ''} onChange={e => setCurrentProject({...currentProject, year: e.target.value})} required />
            </div>
            <div className="form-group">
              <label>Program*</label>
              <input type="text" value={currentProject.program || ''} onChange={e => setCurrentProject({...currentProject, program: e.target.value})} required />
            </div>
            <div className="form-group">
              <label>Study Program (Detailed)</label>
              <input type="text" value={currentProject.studyProgram || ''} onChange={e => setCurrentProject({...currentProject, studyProgram: e.target.value})} />
            </div>
          </div>
        </div>

        <div className="form-section">
          <h3>Categorization & Industry</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>Primary Discipline*</label>
              <input type="text" value={currentProject.discipline || ''} onChange={e => setCurrentProject({...currentProject, discipline: e.target.value})} required />
            </div>
            <div className="form-group">
              <label>Secondary Disciplines (Comma separated)</label>
              <input type="text" value={currentProject.disciplines || ''} onChange={e => setCurrentProject({...currentProject, disciplines: e.target.value})} placeholder="e.g. Robotics, AI" />
            </div>
            <div className="form-group">
              <label>Industry Sector</label>
              <input type="text" value={currentProject.industry || ''} onChange={e => setCurrentProject({...currentProject, industry: e.target.value})} />
            </div>
            <div className="form-group">
              <label>Industry Partner</label>
              <input type="text" value={currentProject.industryPartner || ''} onChange={e => setCurrentProject({...currentProject, industryPartner: e.target.value})} />
            </div>
            <div className="form-group">
              <label>Academic Supervisor</label>
              <input type="text" value={currentProject.academicSupervisor || ''} onChange={e => setCurrentProject({...currentProject, academicSupervisor: e.target.value})} />
            </div>
            <div className="form-group">
              <label>Workflow Status</label>
              <select value={currentProject.status || 'draft'} onChange={e => setCurrentProject({...currentProject, status: e.target.value})}>
                <option value="draft">Draft (Internal)</option>
                <option value="pending_review">Pending Review</option>
                <option value="approved">Approved (Feed Ready)</option>
                <option value="published">Published (Visible)</option>
              </select>
            </div>
          </div>
        </div>

        <div className="form-section">
          <h3>Public Content & Accessibility</h3>
          <div className="form-grid">
            <div className="form-group full-width">
              <label>Summary* (One-liner for cards)</label>
              <textarea value={currentProject.summary || ''} onChange={e => setCurrentProject({...currentProject, summary: e.target.value})} required rows="2" />
            </div>
            <div className="form-group full-width">
              <label>Background (Problem description)</label>
              <textarea value={currentProject.background || ''} onChange={e => setCurrentProject({...currentProject, background: e.target.value})} rows="3" />
            </div>
            <div className="form-group full-width">
              <label>Solution (The output/impact)</label>
              <textarea value={currentProject.solution || ''} onChange={e => setCurrentProject({...currentProject, solution: e.target.value})} rows="3" />
            </div>
            <div className="form-group full-width">
              <label>Poster Full Text* (For Screen Readers)</label>
              <textarea value={currentProject.posterText || ''} onChange={e => setCurrentProject({...currentProject, posterText: e.target.value})} required rows="5" />
            </div>
            <div className="form-group">
              <label>Poster Image URL</label>
              <input type="url" value={currentProject.poster || ''} onChange={e => setCurrentProject({...currentProject, poster: e.target.value})} placeholder="https://..." />
            </div>
            <div className="form-group">
              <label>Image Alt Text (Accessibility)</label>
              <input type="text" value={currentProject.imageAlt || ''} onChange={e => setCurrentProject({...currentProject, imageAlt: e.target.value})} placeholder="A description of the image" />
            </div>
            <div className="form-group full-width">
              <label>Project Snapshots (Comma separated URLs)</label>
              <textarea value={currentProject.snapshots || ''} onChange={e => setCurrentProject({...currentProject, snapshots: e.target.value})} placeholder="URL 1, URL 2, URL 3" rows="3" />
            </div>
          </div>
        </div>

        <div className="form-section">
          <h3>Team & References</h3>
          <div className="form-grid">
            <div className="form-group full-width">
              <label>Team Members* (Comma separated)</label>
              <input type="text" value={currentProject.teamMembers || ''} onChange={e => setCurrentProject({...currentProject, teamMembers: e.target.value})} required placeholder="John Doe, Jane Smith" />
              {(!currentProject.teamMembers || currentProject.teamMembers.trim() === '') && <div className="field-warning">⚠️ Team members list is required for public credit.</div>}
            </div>
            <div className="form-group full-width">
              <label>Citations (Comma separated URLs or text)</label>
              <textarea value={currentProject.citations || ''} onChange={e => setCurrentProject({...currentProject, citations: e.target.value})} placeholder="Reference 1, Reference 2" rows="2" />
            </div>
            <div className="form-group full-width">
              <label>Internal Staff Notes (Not for public feed)</label>
              <textarea value={currentProject.internalNotes || ''} onChange={e => setCurrentProject({...currentProject, internalNotes: e.target.value})} placeholder="Notes for review..." rows="2" />
            </div>
          </div>
        </div>

        <div className="form-actions-sticky">
          <button type="button" className="btn-cancel" onClick={() => setView('list')}>Cancel</button>
          <button type="submit" className="btn-primary btn-large" disabled={loading}>
            {loading ? 'Saving...' : 'Save Project Changes'}
          </button>
        </div>
      </form>
    </section>
  );

  const renderPublicPreview = () => {
    // Group projects by year
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
                  <div className="card-image">
                    <img src={p.poster || 'https://via.placeholder.com/400x600?text=No+Poster'} alt={p.imageAlt || p.title} />
                  </div>
                  <div className="card-content">
                    <span className="card-discipline">{p.discipline}</span>
                    <h3>{p.title}</h3>
                    <p className="card-summary">{p.summary}</p>
                    <button className="btn-learn-more" onClick={() => { setPreviewProject(p); setView('detail'); }}>Learn More</button>
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
    if (!previewProject) return null;
    return (
      <section className="duda-detail">
        <div className="detail-header">
          <button className="btn-back" onClick={() => setView('public')}>← Back to Showcase</button>
          <h1>{previewProject.title}</h1>
          <p className="detail-meta">{previewProject.program} | {previewProject.year}</p>
        </div>

        <div className="detail-content-grid">
          <div className="detail-main">
            <div className="detail-section">
              <h3>Background</h3>
              <p>{previewProject.background || 'No background information provided.'}</p>
            </div>
            <div className="detail-section">
              <h3>The Solution</h3>
              <p>{previewProject.solution || 'No solution information provided.'}</p>
            </div>
            
            {previewProject.snapshots && previewProject.snapshots.length > 0 && (
              <div className="detail-section">
                <h3>Project Snapshots</h3>
                <div className="snapshot-grid">
                  {previewProject.snapshots.map((url, idx) => (
                    <div key={idx} className="snapshot-item" onClick={() => setLightboxIndex(idx)}>
                      <img src={url} alt={`Snapshot ${idx + 1}`} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="detail-section">
              <h3>The Team</h3>
              <ul className="team-list">
                {Array.isArray(previewProject.teamMembers) ? previewProject.teamMembers.map((m, i) => <li key={i}>{m}</li>) : <li>{previewProject.teamMembers}</li>}
              </ul>
            </div>
          </div>

          <aside className="detail-sidebar">
            <div className="sidebar-poster">
              <img src={previewProject.poster || 'https://via.placeholder.com/400x600?text=No+Poster'} alt={previewProject.imageAlt || previewProject.title} />
            </div>
            <div className="sidebar-info">
              <div className="info-item">
                <label>Industry Partner</label>
                <p>{previewProject.industryPartner || 'N/A'}</p>
              </div>
              <div className="info-item">
                <label>Academic Supervisor</label>
                <p>{previewProject.academicSupervisor || 'N/A'}</p>
              </div>
              <div className="info-item">
                <label>Disciplines</label>
                <p>{Array.isArray(previewProject.disciplines) ? previewProject.disciplines.join(', ') : previewProject.disciplines}</p>
              </div>
            </div>
          </aside>
        </div>

        {lightboxIndex >= 0 && (
          <div className="lightbox" onClick={() => setLightboxIndex(-1)}>
            <div className="lightbox-content" onClick={e => e.stopPropagation()}>
              <button className="lightbox-close" onClick={() => setLightboxIndex(-1)}>×</button>
              <img src={previewProject.snapshots[lightboxIndex]} alt="Full size snapshot" />
              <div className="lightbox-nav">
                <button className="nav-prev" onClick={() => setLightboxIndex((lightboxIndex - 1 + previewProject.snapshots.length) % previewProject.snapshots.length)}>‹</button>
                <button className="nav-next" onClick={() => setLightboxIndex((lightboxIndex + 1) % previewProject.snapshots.length)}>›</button>
              </div>
            </div>
          </div>
        )}
      </section>
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
          <div className="nav-separator">Public Layer Proof</div>
          <button className={view === 'public' || view === 'detail' ? 'active' : ''} onClick={() => setView('public')}>Public Preview</button>
        </nav>
        <div className="sidebar-footer">
          <div className="status-indicator">
            <span className="dot"></span> Local Server: Online
          </div>
        </div>
      </aside>

      <div className="main-wrapper">
        {!(view === 'public' || view === 'detail') && (
          <header className="main-header">
            <div className="header-title">
              {view === 'dashboard' && 'Dashboard Overview'}
              {view === 'list' && 'Project Management'}
              {view === 'edit' && 'Review Project Metadata'}
            </div>
            <div className="header-actions">
              <button className="btn-generate-header" onClick={handleGenerateFeed}>Sync Feed</button>
            </div>
          </header>
        )}

        <div className="content-area">
          {message && <div className={`global-toast ${message.includes('Error') ? 'error' : 'success'}`}>{message}</div>}
          
          {view === 'dashboard' && renderDashboard()}
          {view === 'list' && renderProjectList()}
          {view === 'edit' && renderProjectForm()}
          {view === 'public' && renderPublicPreview()}
          {view === 'detail' && renderProjectDetail()}
        </div>
      </div>
    </div>
  );
}

export default App;
