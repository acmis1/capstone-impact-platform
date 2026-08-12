import React from 'react';
import { PublicationReadinessResult } from '../../domain/publicationReadiness';

interface PublicationReadinessPanelProps {
  readiness: PublicationReadinessResult | null;
}

export function PublicationReadinessPanel({ readiness }: PublicationReadinessPanelProps) {
  if (!readiness) {
    return (
      <div style={{
        backgroundColor: '#1E293B',
        borderRadius: '8px',
        padding: '1.25rem',
        border: '1px solid rgba(255, 255, 255, 0.05)',
      }}>
        <div style={{ color: '#9CA3AF', fontSize: '0.85rem' }}>
          <strong style={{ color: '#F59E0B' }}>Publication readiness unavailable.</strong>
          <div style={{ marginTop: '0.35rem' }}>
            Publication preparation and Local publication are disabled until readiness can be verified.
          </div>
        </div>
      </div>
    );
  }

  const { ready, resultCode, blockers, confirmedAt } = readiness;

  let headerColor = '#EF4444';
  let headerBg = 'rgba(239, 68, 68, 0.1)';
  let headerBorder = 'rgba(239, 68, 68, 0.2)';
  let titleText = 'NOT READY FOR PUBLICATION';

  if (ready && resultCode === 'READY') {
    headerColor = '#10B981';
    headerBg = 'rgba(16, 185, 129, 0.1)';
    headerBorder = 'rgba(16, 185, 129, 0.2)';
    titleText = 'READY FOR PUBLICATION';
  } else if (resultCode === 'NO_ACTIVE_PREVIEW') {
    titleText = 'PARTICIPANT PREVIEW REQUIRED';
    headerColor = '#F59E0B';
    headerBg = 'rgba(245, 158, 11, 0.1)';
    headerBorder = 'rgba(245, 158, 11, 0.2)';
  } else if (resultCode === 'PREVIEW_NOT_CONFIRMED') {
    titleText = 'WAITING FOR PARTICIPANT CONFIRMATION';
    headerColor = '#F59E0B';
    headerBg = 'rgba(245, 158, 11, 0.1)';
    headerBorder = 'rgba(245, 158, 11, 0.2)';
  } else if (resultCode === 'CORRECTION_UNRESOLVED') {
    titleText = 'PARTICIPANT CORRECTION MUST BE RESOLVED';
  } else if (resultCode === 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION') {
    titleText = 'CORRECTED PREVIEW AWAITING PARTICIPANT CONFIRMATION';
    headerColor = '#F59E0B';
    headerBg = 'rgba(245, 158, 11, 0.1)';
    headerBorder = 'rgba(245, 158, 11, 0.2)';
  } else if (resultCode === 'PROJECT_SNAPSHOT_STALE') {
    titleText = 'PROJECT INFORMATION CHANGED AFTER PARTICIPANT CONFIRMATION';
  } else if (resultCode === 'MEDIA_SNAPSHOT_STALE') {
    titleText = 'PROJECT MEDIA CHANGED AFTER PARTICIPANT CONFIRMATION';
  } else if (resultCode === 'INVALID_PROJECT_STATE') {
    titleText = 'PROJECT MUST BE IN APPROVED STATUS';
    headerColor = '#6B7280';
    headerBg = 'rgba(107, 114, 128, 0.1)';
    headerBorder = 'rgba(107, 114, 128, 0.2)';
  } else if (resultCode === 'READINESS_UNAVAILABLE') {
    titleText = 'PUBLICATION READINESS UNAVAILABLE';
    headerColor = '#6B7280';
    headerBg = 'rgba(107, 114, 128, 0.1)';
    headerBorder = 'rgba(107, 114, 128, 0.2)';
  }

  return (
    <div style={{
      backgroundColor: '#161F30',
      borderRadius: '8px',
      padding: '1.25rem',
      border: '1px solid rgba(255, 255, 255, 0.05)',
    }}>
      <div style={{
        backgroundColor: headerBg,
        border: `1px solid ${headerBorder}`,
        borderRadius: '6px',
        padding: '0.75rem 1rem',
        marginBottom: '1rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ color: headerColor, fontWeight: 'bold', fontSize: '0.9rem' }}>
          {ready ? '✅' : '🔒'} {titleText}
        </span>
        <code style={{ fontSize: '0.75rem', color: '#9CA3AF' }}>{resultCode}</code>
      </div>

      {confirmedAt && (
        <div style={{ fontSize: '0.8rem', color: '#9CA3AF', marginBottom: '0.75rem' }}>
          <strong>Participant Confirmation Timestamp:</strong> {new Date(confirmedAt).toLocaleString()}
        </div>
      )}

      {blockers.length > 0 && (
        <div>
          <div style={{ fontSize: '0.8rem', color: '#EF4444', fontWeight: 'bold', marginBottom: '0.35rem' }}>
            Publication Gate Blockers:
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', color: '#D1D5DB', fontSize: '0.85rem' }}>
            {blockers.map((blocker, i) => (
              <li key={i}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {ready && (
        <p style={{ margin: 0, color: '#10B981', fontSize: '0.85rem' }}>
          All publication readiness invariants are satisfied. Project metadata and private media match the confirmed participant snapshot.
        </p>
      )}
    </div>
  );
}
