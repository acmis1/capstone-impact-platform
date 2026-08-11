'use client';

import { useState } from 'react';

interface Plan { publicId: string; confirmedPreviewId: string; confirmedAt: string; recordCount: number; feedHash: string; }
export function PublicationPreparationPanel({ publicId, ready, canPrepare }: { publicId: string; ready: boolean; canPrepare: boolean }) {
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null); const [plan, setPlan] = useState<Plan | null>(null);
  if (!canPrepare || !ready) return null;
  async function generate() {
    setPending(true); setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(publicId)}/publication-plan`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Publication plan is unavailable.');
      setPlan(data.result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Publication plan is unavailable.'); } finally { setPending(false); }
  }
  return <div style={{ marginTop: '1rem', fontSize: '0.85rem' }}>
    <button type="button" onClick={generate} disabled={pending} style={{ background: '#10B981', color: '#fff', border: 0, borderRadius: 6, padding: '0.55rem 0.9rem', fontWeight: 'bold', cursor: pending ? 'wait' : 'pointer' }}>{pending ? 'Generating plan…' : 'Generate publication plan'}</button>
    {error && <p style={{ color: '#EF4444' }}>{error}</p>}
    {plan && <div style={{ marginTop: '0.75rem', padding: '0.8rem', border: '1px solid rgba(16,185,129,.3)', borderRadius: 6 }}><strong>Preparation only — nothing has been published.</strong><br />Project: <code>{plan.publicId}</code><br />Confirmed preview: <code>{plan.confirmedPreviewId}</code><br />Confirmed: {new Date(plan.confirmedAt).toLocaleString()}<br />Candidate records: {plan.recordCount}<br />SHA-256: <code style={{ wordBreak: 'break-all' }}>{plan.feedHash}</code></div>}
  </div>;
}
