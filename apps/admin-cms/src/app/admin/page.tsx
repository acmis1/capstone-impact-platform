import Link from 'next/link';

export default function AdminPage() {
  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0B0F19',
      color: '#F3F4F6',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '2rem',
    }}>
      <div style={{
        maxWidth: '1000px',
        margin: '0 auto',
      }}>
        {/* Navigation header */}
        <header style={{
          display: 'flex',
          justifyContent: 'between',
          alignItems: 'center',
          marginBottom: '3rem',
          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
          paddingBottom: '1rem',
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 800 }}>Admin/CMS Staging Console</h1>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.9rem', color: '#9CA3AF' }}>Operational Workspace — Security & Feed Validation Staged</p>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <Link href="/" style={{
              color: '#3B82F6',
              textDecoration: 'none',
              fontSize: '0.9rem',
              fontWeight: 600,
            }}>
              Back to Home
            </Link>
          </div>
        </header>

        {/* Dashboard Grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '2rem',
          marginBottom: '3rem',
        }}>
          {/* Status Column */}
          <div style={{
            backgroundColor: '#161F30',
            borderRadius: '12px',
            padding: '2rem',
            border: '1px solid rgba(255, 255, 255, 0.05)',
          }}>
            <h2 style={{ fontSize: '1.25rem', marginTop: 0, color: '#3B82F6', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '0.5rem' }}>Staging Baseline Status</h2>
            <ul style={{ paddingLeft: '1.25rem', lineHeight: '1.8', color: '#D1D5DB', fontSize: '0.95rem' }}>
              <li><strong>App Router Workspace</strong>: Verified</li>
              <li><strong>TypeScript Compilation</strong>: Verified</li>
              <li><strong>Zod Environment Validation</strong>: Staged</li>
              <li><strong>Public Feed Compilation</strong>: FNV-1a Hashed</li>
              <li><strong>Core Mock Fixture Data</strong>: Staged</li>
            </ul>
          </div>

          {/* Connection Isolation Column */}
          <div style={{
            backgroundColor: '#161F30',
            borderRadius: '12px',
            padding: '2rem',
            border: '1px solid rgba(255, 255, 255, 0.05)',
          }}>
            <h2 style={{ fontSize: '1.25rem', marginTop: 0, color: '#F59E0B', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '0.5rem' }}>Connection & Storage Isolation</h2>
            <ul style={{ paddingLeft: '1.25rem', lineHeight: '1.8', color: '#D1D5DB', fontSize: '0.95rem' }}>
              <li><strong>Duda Connection</strong>: Not connected (Locked)</li>
              <li><strong>Supabase Database</strong>: Staging config locked</li>
              <li><strong>Private Ingestion Storage</strong>: drafts-private configured</li>
              <li><strong>Public Ingestion Storage</strong>: public-assets configured</li>
              <li><strong>Gemini API Calls</strong>: Disabled (Safe)</li>
            </ul>
          </div>
        </div>

        {/* Audit Report Container */}
        <div style={{
          backgroundColor: '#161F30',
          borderRadius: '12px',
          padding: '2rem',
          border: '1px solid rgba(255, 255, 255, 0.05)',
        }}>
          <h2 style={{ fontSize: '1.25rem', marginTop: 0, color: '#10B981', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '0.5rem' }}>Staged Verification Scripts</h2>
          <p style={{ fontSize: '0.95rem', color: '#D1D5DB', lineHeight: '1.6' }}>
            To run the staging validation test suite and verify the approved-only feed compiler locally, execute the following commands in the workspace terminal:
          </p>
          <pre style={{
            backgroundColor: '#0F172A',
            padding: '1rem',
            borderRadius: '8px',
            color: '#34D399',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.9rem',
            overflowX: 'auto',
          }}>
            # Perform TypeScript check<br />
            npm run typecheck<br /><br />
            # Compile mock projects and validate feed contract<br />
            npm run check:sample-feed
          </pre>
        </div>
      </div>
    </div>
  );
}
