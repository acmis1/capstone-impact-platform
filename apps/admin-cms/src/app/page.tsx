import Link from 'next/link';

export default function Home() {
  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0B0F19',
      color: '#F3F4F6',
      fontFamily: 'Inter, system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      padding: '2rem',
    }}>
      <main style={{
        maxWidth: '800px',
        width: '100%',
        backgroundColor: '#161F30',
        borderRadius: '16px',
        padding: '3rem',
        boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3)',
        border: '1px solid rgba(255, 255, 255, 0.05)',
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          fontSize: '2.5rem',
          fontWeight: 800,
          marginBottom: '1rem',
          textAlign: 'center',
        }}>
          Capstone Impact Platform
        </div>
        <p style={{
          color: '#9CA3AF',
          fontSize: '1.1rem',
          textAlign: 'center',
          marginBottom: '3rem',
        }}>
          Actual Production Staging Foundation — School-Owned Admin/CMS
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1.5rem',
          marginBottom: '3rem',
        }}>
          {/* Status Card 1 */}
          <div style={{
            backgroundColor: '#1E293B',
            padding: '1.5rem',
            borderRadius: '12px',
            borderLeft: '4px solid #10B981',
          }}>
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', color: '#10B981' }}>Staging CMS Workspace</h3>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#9CA3AF' }}>Next.js App Router & TypeScript framework initialized safely.</p>
          </div>

          {/* Status Card 2 */}
          <div style={{
            backgroundColor: '#1E293B',
            padding: '1.5rem',
            borderRadius: '12px',
            borderLeft: '4px solid #EF4444',
          }}>
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', color: '#EF4444' }}>Duda Not Connected</h3>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#9CA3AF' }}>Public showcase is isolated; no live synchronization triggers active during staging.</p>
          </div>

          {/* Status Card 3 */}
          <div style={{
            backgroundColor: '#1E293B',
            padding: '1.5rem',
            borderRadius: '12px',
            borderLeft: '4px solid #3B82F6',
          }}>
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', color: '#3B82F6' }}>Supabase Configured</h3>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#9CA3AF' }}>Linked to the 'capstone-impact-staging' storage project via environment variables.</p>
          </div>

          {/* Status Card 4 */}
          <div style={{
            backgroundColor: '#1E293B',
            padding: '1.5rem',
            borderRadius: '12px',
            borderLeft: '4px solid #F59E0B',
          }}>
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', color: '#F59E0B' }}>Gemini Extraction</h3>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#9CA3AF' }}>Assistive form-filling model integrated and disabled by default.</p>
          </div>
        </div>

        <div style={{
          backgroundColor: '#1E293B',
          padding: '1.5rem',
          borderRadius: '12px',
          marginBottom: '3rem',
          border: '1px dashed rgba(255, 255, 255, 0.1)',
        }}>
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', color: '#F3F4F6' }}>🛡️ Safety Boundaries & Protection</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.9rem', color: '#9CA3AF', lineHeight: '1.6' }}>
            <li>Existing <strong>Prototype/</strong> folder remains completely untouched and preserved.</li>
            <li>No database credentials or secret keys are exposed or committed to the public Git repository.</li>
            <li>All staging tests utilize strictly generated, mock data datasets to satisfy privacy policies.</li>
          </ul>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Link href="/admin" style={{
            backgroundColor: '#3B82F6',
            color: '#FFFFFF',
            padding: '0.75rem 2rem',
            borderRadius: '8px',
            textDecoration: 'none',
            fontWeight: '600',
            transition: 'background-color 0.2s',
          }}>
            Go to Admin CMS Panel
          </Link>
        </div>
      </main>
    </div>
  );
}
