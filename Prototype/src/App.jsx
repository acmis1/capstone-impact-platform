import React, { useState, useEffect } from 'react';
import './styles.css';

const API_URL = '/api';

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
  const [statusFilter, setStatusFilter] = useState('all');
  const [adminKey, setAdminKey] = useState(localStorage.getItem('capstone_admin_key') || '');

  useEffect(() => {
    fetchProjects();
    fetchFeedStatus();
  }, []);

  // Handle scroll lock and Esc key for lightbox
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
        // Success message with detailed diagnostics
        const excludedDetail = data.excludedStatuses ? 
          Object.entries(data.excludedStatuses).map(([s, c]) => `${c} ${s}`).join(', ') : 
          `${data.archivedCount || 0} archived`;

        const diag = `Successfully synced ${data.count} records to the official showcase. (Excluded ${excludedDetail}). ${data.updatedCount || 0} records moved to Published.`;
        alert(diag);
        setCloudStatus({ type: 'success', message: diag });
        setCloudUrl(data.publicUrl);
        fetchProjects(); // Refresh to see status changes
        fetchFeedStatus();
      } else {
        setCloudStatus({ type: 'error', message: data.error || 'Official sync failed.' });
      }
    } catch (err) {
      setCloudStatus({ type: 'error', message: 'Network error while syncing.' });
    }
  };

  const handleEdit = (project) => {
    // Convert arrays to strings for editing (snapshots use newlines for clarity)
    const editProject = {
      ...project,
      disciplines: Array.isArray(project.disciplines) ? project.disciplines.join(', ') : project.disciplines || '',
      teamMembers: Array.isArray(project.teamMembers) ? project.teamMembers.join(', ') : project.teamMembers || '',
      citations: Array.isArray(project.citations) ? project.citations.join(', ') : project.citations || '',
      snapshots: Array.isArray(project.snapshots) ? project.snapshots.join('\n') : project.snapshots || ''
    };
    setCurrentProject(editProject);
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
    console.log('handleSave triggered');
    setLoading(true);
    
    try {
      const projectToSave = prepareProjectForSave(currentProject);
      if (!projectToSave) throw new Error('No project selected to save');

      console.log('Project to save (prepared):', projectToSave);

      console.log('Project to save (prepared):', projectToSave);

      const method = projectToSave.id ? 'PUT' : 'POST';
      const url = projectToSave.id ? `${API_URL}/projects/${projectToSave.id}` : `${API_URL}/projects`;

      console.log(`Sending ${method} request to ${url}`);

      const res = await fetch(url, {
        method,
        headers: { 
          'Content-Type': 'application/json',
          'x-admin-key': adminKey
        },
        body: JSON.stringify(projectToSave),
      });

      console.log('Response status:', res.status);

      if (res.ok) {
        setMessage('Project saved successfully!');
        fetchProjects();
        setTimeout(() => {
          setView('list');
          setMessage(null);
        }, 1500);
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.error('Server error data:', errorData);
        setMessage(`Error saving project: ${errorData.error || res.statusText}`);
      }
    } catch (err) {
      console.error('Error in handleSave catch block:', err);
      setMessage(`Error saving project: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateFeed = async () => {
    if (view === 'edit') {
      if (!window.confirm("You have unsaved changes in the editor. These will NOT be included in the feed until you click 'Save & Update Record'. Proceed anyway?")) {
        return;
      }
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/generate-feed`, { 
        method: 'POST',
        headers: {
          'x-admin-key': adminKey
        }
      });
      const data = await res.json();
      if (data.success) {
        const excludedDetail = data.excludedStatuses ? 
          Object.entries(data.excludedStatuses).map(([s, c]) => `${c} ${s}`).join(', ') : 
          `${data.archivedCount || 0} archived`;

        const diag = `Local Preview feed updated with ${data.count} projects. Excluded: ${excludedDetail}.`;
        setMessage(diag);
        fetchFeedStatus();
        setTimeout(() => setMessage(null), 8000);
      }
    } catch (err) {
      console.error('Error generating feed:', err);
      setMessage('Error updating local feed.');
    } finally {
      setLoading(false);
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
            <div className="stat-val">{getStatusCount('published')}</div>
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
              Manage how project data is synchronized to the public showcase.
            </p>
            
            {feedStatus?.exists ? (
              <div className="feed-info" style={{ marginBottom: '1.5rem' }}>
                <div className="info-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Public Records Count:</span>
                  <span className="highlight" style={{ fontWeight: 'bold', color: 'var(--success)' }}>{feedStatus.count}</span>
                </div>
                <div className="info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Last Distribution:</span>
                  <span>{new Date(feedStatus.lastUpdated).toLocaleString()}</span>
                </div>
              </div>
            ) : (
              <p style={{ marginBottom: '1.5rem' }}>Public feed has not been generated yet.</p>
            )}

            <div className="feed-actions" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <button onClick={handleGenerateFeed} className="btn-outline" style={{ width: '100%' }} title="Updates the local feed file (capstones-latest.json) for immediate previewing. Does NOT update the live Duda site.">
                Generate Local Feed
              </button>
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
            <button className="btn-success" onClick={() => { setCurrentProject({ status: 'submitted' }); setView('edit'); }}>+ Add / Import Submission</button>
          </div>
        </div>
        <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '15px' }}>
          Only <strong>Published</strong> records are live on the public Duda showcase. <strong>Approved</strong> records are queued for next publish.
        </p>
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
            {filteredProjects.map(p => (
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
  };

  const setProjectStatus = (status) => {
    setCurrentProject(prev => ({ ...prev, status }));
    setMessage(`Status updated to: ${status.replace('_', ' ')}`);
    setTimeout(() => setMessage(null), 2000);
  };

  const renderProjectForm = () => {
    return (
      <section className="project-form">
        <div className="section-header">
          <h2>{currentProject.id ? 'Edit & Review Project' : 'New Project Entry'}</h2>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <button type="button" className="btn-cancel" onClick={() => setView('list')}>Back to List</button>
          </div>
        </div>

        <div className="workflow-action-panel" style={{ 
          background: 'white', 
          padding: '1.5rem', 
          borderRadius: '12px', 
          marginBottom: '2rem',
          boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
          border: '1px solid var(--border)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h4 style={{ color: 'var(--primary)', marginBottom: '0.5rem' }}>Management Lifecycle</h4>
              <div className={`status-pill ${currentProject.status || 'submitted'}`} style={{ display: 'inline-block' }}>
                Current Status: {currentProject.status ? currentProject.status.replace('_', ' ').toUpperCase() : 'SUBMITTED'}
              </div>
            </div>
            <div className="action-buttons" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn-outline" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => { 
                const note = prompt("Enter specific changes required (sent to student group):");
                if (note) {
                  setCurrentProject({ ...currentProject, status: 'changes_requested', reviewNotes: note });
                  setMessage("Project marked as Changes Requested.");
                }
              }}>Request Changes</button>
              
              <button type="button" className="btn-outline" onClick={() => setProjectStatus('in_review')}>Mark In Review</button>
              
              <button type="button" className="btn-outline" onClick={() => {
                setProjectStatus('preview_sent');
                alert("STAKEHOLDER DEMO:\n\nIn the production system, this sends a secure one-time preview link to the student group: \n\nhttps://showcase.rmit.edu.vn/preview/" + (currentProject.id || 'temp-id'));
              }}>Send Proof Link</button>
              
              <button type="button" className="btn-outline" onClick={() => setProjectStatus('student_confirmed')}>Log Student Confirmed</button>
              
              <button type="button" className="btn-success" onClick={() => setProjectStatus('approved')}>Approve for Publish</button>

              {(currentProject.status === 'published' || currentProject.status === 'approved') && (
                <button type="button" className="btn-outline" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={async () => {
                  if (window.confirm("Archive this project? It will be removed from the official showcase after the next 'Publish to Duda' action.")) {
                    const reason = prompt("Optional: Archive Reason (e.g. 'Project Withdrawn', 'Incorrect Data'):");
                    
                    // Use helper to ensure data integrity
                    const baseProject = prepareProjectForSave(currentProject);
                    const updatedProject = { 
                      ...baseProject, 
                      status: 'archived', 
                      archivedAt: new Date().toISOString(),
                      archiveReason: reason || 'Archived by staff'
                    };
                    
                    // Immediate Save to Backend
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

        <div className="ai-assist-panel" style={{ 
          background: '#f8fafc', 
          padding: '1.5rem', 
          borderRadius: '12px', 
          marginBottom: '2rem',
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

        <form onSubmit={handleSave}>
          <div className="form-section">
            <h3>Section A: Source Files & Media</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>Poster Image URL</label>
                <input type="url" value={currentProject.poster || ''} onChange={e => setCurrentProject({...currentProject, poster: e.target.value})} placeholder="https://..." />
                <p className="field-helper">Production: Secure file upload to RMIT S3.</p>
              </div>
              <div className="form-group">
                <label>Poster PDF/File URL</label>
                <input type="url" value={currentProject.posterPdf || ''} onChange={e => setCurrentProject({...currentProject, posterPdf: e.target.value})} placeholder="https://..." />
                <p className="field-helper">Required for "Get Poster" button in detail page.</p>
              </div>
              <div className="form-group full-width">
                <label>Project Snapshots (Gallery - one URL per line)</label>
                <textarea value={currentProject.snapshots || ''} onChange={e => setCurrentProject({...currentProject, snapshots: e.target.value})} rows="4" placeholder="https://..." />
              </div>
              <div className="form-group">
                <label>Image Alt Text</label>
                <input type="text" value={currentProject.imageAlt || ''} onChange={e => setCurrentProject({...currentProject, imageAlt: e.target.value})} placeholder="Description for accessibility..." />
              </div>
            </div>
          </div>

          <div className="form-section">
            <h3>Section B: Project Content & Metadata</h3>
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
            </div>
          </div>

          <div className="form-section">
            <h3>Section C: Administrative Controls</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>Year*</label>
                <input type="text" value={currentProject.year || ''} onChange={e => setCurrentProject({...currentProject, year: e.target.value})} required />
              </div>
              <div className="form-group">
                <label>Study Program*</label>
                <input type="text" value={currentProject.program || ''} onChange={e => setCurrentProject({...currentProject, program: e.target.value})} required />
              </div>
              <div className="form-group">
                <label>Primary Discipline*</label>
                <input type="text" value={currentProject.discipline || ''} onChange={e => setCurrentProject({...currentProject, discipline: e.target.value})} required />
              </div>
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

          <div className="form-actions-sticky">
            <button type="button" className="btn-cancel" onClick={() => setView('list')}>Cancel</button>
            <button type="submit" className="btn-primary btn-large" disabled={loading}>
              {loading ? 'Processing...' : 'Save & Update Record'}
            </button>
          </div>
        </form>
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
    if (!previewProject) {
      return (
        <div className="error-fallback" style={{ padding: '4rem', textAlign: 'center', background: 'var(--bg-dark)', borderRadius: '12px', color: 'white' }}>
          <h2 style={{ marginBottom: '1.5rem' }}>Project preview could not be loaded.</h2>
          <button className="btn-primary" onClick={() => setView('public')}>Return to Showcase</button>
        </div>
      );
    }
    return (
      <section className="duda-detail">
        <div className="detail-header">
          <button className="btn-back" onClick={() => setView('public')}>
            <span className="back-icon">&larr;</span> Return to Showcase
          </button>
          <div className="detail-title-block">
            <h1>{previewProject.title}</h1>
            <p className="detail-meta">
              <span className="meta-program">{previewProject.program}</span>
              <span className="meta-sep">|</span>
              <span className="meta-year">{previewProject.year}</span>
            </p>
          </div>
        </div>

        <div className="detail-content-grid">
          <div className="detail-main">
            <div className="detail-section">
              <h3 className="section-title">Background</h3>
              <p className="section-text">{previewProject.background || 'No background information provided.'}</p>
            </div>
            
            <div className="detail-section">
              <h3 className="section-title">The Solution</h3>
              <p className="section-text">{previewProject.solution || 'No solution information provided.'}</p>
            </div>
            
            {previewProject.snapshots && previewProject.snapshots.length > 0 && (
              <div className="detail-section">
                <h3 className="section-title">Project Snapshots</h3>
                <div className="snapshot-grid">
                  {previewProject.snapshots.map((url, idx) => (
                    <div key={idx} className="snapshot-card" onClick={() => setLightboxIndex(idx)}>
                      <div className="snapshot-inner">
                        <img src={url} alt={`Snapshot ${idx + 1}`} loading="lazy" />
                        <div className="snapshot-overlay">
                          <span className="view-icon">VIEW</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="detail-sidebar">
            <div className="sticky-sidebar">
              <div className="sidebar-poster-card">
                <img 
                  src={previewProject.poster || 'https://via.placeholder.com/400x600?text=No+Poster'} 
                  alt={previewProject.imageAlt || previewProject.title} 
                  className="poster-img"
                />
              </div>
              <div className="sidebar-action">
                <a 
                  href={previewProject.posterPdf || previewProject.poster || '#'} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="btn-get-poster"
                >
                  View Project Poster (PDF)
                </a>
              </div>
              <div className="sidebar-metadata-card">
                <h4 className="card-title">Project Details</h4>
                <div className="metadata-list">
                  <div className="metadata-item">
                    <span className="metadata-label">Academic Supervisor</span>
                    <span className="metadata-value">{previewProject.academicSupervisor || 'N/A'}</span>
                  </div>
                  <div className="metadata-item">
                    <span className="metadata-label">Industry Partner</span>
                    <span className="metadata-value">{previewProject.industryPartner || 'N/A'}</span>
                  </div>
                  <div className="metadata-item">
                    <span className="metadata-label">Program</span>
                    <span className="metadata-value">{previewProject.program}</span>
                  </div>
                  <div className="metadata-item">
                    <span className="metadata-label">Discipline</span>
                    <span className="metadata-value">{previewProject.discipline}</span>
                  </div>
                  <div className="metadata-item">
                    <span className="metadata-label">Year</span>
                    <span className="metadata-value">{previewProject.year}</span>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>

        <div className="detail-footer-section" style={{ marginTop: '6rem' }}>
          <div className="detail-section">
            <h3 className="section-title">The Team</h3>
            <div className="team-container">
              {previewProject.groupName && <p className="group-name">Group: {previewProject.groupName}</p>}
              <ul className="team-chips">
                {(Array.isArray(previewProject.teamMembers) 
                  ? previewProject.teamMembers 
                  : (previewProject.teamMembers || '').split(',')
                ).map((name, idx) => (
                  <li key={idx} className="team-chip">{name.trim()}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {lightboxIndex >= 0 && (
          <div className="lightbox-overlay" onClick={() => setLightboxIndex(-1)}>
            <div className="lightbox-container" onClick={e => e.stopPropagation()}>
              <button className="lightbox-close-btn" onClick={() => setLightboxIndex(-1)}>X</button>
              <div className="lightbox-image-wrapper">
                <img src={previewProject.snapshots[lightboxIndex]} alt="Full size snapshot" />
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
            </div>
            <div className="header-actions">
              <button className="btn-generate-header" onClick={handleGenerateFeed}>Generate Feed</button>
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
