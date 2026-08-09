'use client';

import React, { useState, useRef } from 'react';
import {
  deriveMimeType,
  generateUploadKey,
  isIgnoredSystemFile,
  normalizeRelativePath,
} from '../../import/browserSelection';
import {
  BrowserImportPreviewResponse,
  SelectedFileDescriptor,
  SelectionManifest,
  validateBrowserImportPreviewResponse,
} from '../../import/browserImportPreviewContract';

export default function BrowserImportPreviewClient() {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isSupported] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const inputEl = document.createElement('input');
    return 'webkitdirectory' in inputEl;
  });
  const [selectedRootName, setSelectedRootName] = useState<string | null>(null);
  const [declaredTotalBytes, setDeclaredTotalBytes] = useState(0);
  const [detectedPackageCount, setDetectedPackageCount] = useState(0);

  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<BrowserImportPreviewResponse['batch'] | null>(null);
  const [expandedPackages, setExpandedPackages] = useState<Record<string, boolean>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFolderSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;

    setApiError(null);
    setPreviewResult(null);

    const descriptors: SelectedFileDescriptor[] = [];
    let totalBytes = 0;
    const packagePaths = new Set<string>();

    for (const file of files) {
      const relPath = file.webkitRelativePath || file.name;
      const norm = normalizeRelativePath(relPath);

      if (!norm) continue;
      if (isIgnoredSystemFile(norm)) {
        continue;
      }

      totalBytes += file.size;
      const parts = norm.split('/');
      const fileName = parts[parts.length - 1];
      const mime = deriveMimeType(fileName, file.type).mimeType;
      const pkgPath = parts.length >= 2 ? (parts.length === 2 ? parts[0] : `${parts[0]}/${parts[1]}`) : parts[0];
      packagePaths.add(pkgPath);

      descriptors.push({
        uploadKey: generateUploadKey(norm),
        originalPath: relPath,
        normalizedPath: norm,
        fileName,
        fileSizeBytes: file.size,
        mimeType: mime,
        packagePath: pkgPath,
      });
    }

    if (descriptors.length === 0) {
      setApiError('The selected folder contains no valid project package files.');
      setSelectedFiles([]);
      setSelectedRootName(null);
      return;
    }

    const rootName = descriptors[0].normalizedPath.split('/')[0];
    setSelectedFiles(files);
    setSelectedRootName(rootName);
    setDeclaredTotalBytes(totalBytes);
    setDetectedPackageCount(packagePaths.size);
  };

  const handleRequestPreview = async () => {
    if (selectedFiles.length === 0 || !selectedRootName) return;

    setIsLoading(true);
    setApiError(null);

    try {
      const descriptors: SelectedFileDescriptor[] = [];
      const metadataFilesToUpload: File[] = [];
      let totalBytes = 0;
      let ignoredCount = 0;

      for (const file of selectedFiles) {
        const relPath = file.webkitRelativePath || file.name;
        const norm = normalizeRelativePath(relPath);

        if (!norm || isIgnoredSystemFile(norm)) {
          if (norm && isIgnoredSystemFile(norm)) ignoredCount++;
          continue;
        }

        totalBytes += file.size;
        const parts = norm.split('/');
        const fileName = parts[parts.length - 1];
        const lowerName = fileName.toLowerCase();
        const mime = deriveMimeType(fileName, file.type).mimeType;
        const uploadKey = generateUploadKey(norm);
        const pkgPath = parts.length >= 2 ? (parts.length === 2 ? parts[0] : `${parts[0]}/${parts[1]}`) : parts[0];

        descriptors.push({
          uploadKey,
          originalPath: relPath,
          normalizedPath: norm,
          fileName,
          fileSizeBytes: file.size,
          mimeType: mime,
          packagePath: pkgPath,
        });

        // Browser preview rule: Media binary files STAY in browser! Only metadata attached.
        if (lowerName === 'project-details.xlsx' || lowerName === 'project.json') {
          metadataFilesToUpload.push(file);
        }
      }

      const manifest: SelectionManifest = {
        selectedRootName,
        fileCount: descriptors.length,
        declaredTotalBytes: totalBytes,
        ignoredSystemFilesCount: ignoredCount,
        descriptors,
      };

      const formData = new FormData();
      formData.append('manifest', JSON.stringify(manifest));

      for (const metaFile of metadataFilesToUpload) {
        const relPath = metaFile.webkitRelativePath || metaFile.name;
        const norm = normalizeRelativePath(relPath)!;
        const key = generateUploadKey(norm);
        formData.append(key, metaFile);
      }

      const res = await fetch('/api/imports/preview', {
        method: 'POST',
        body: formData,
      });

      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        throw new Error('SERVER_NON_JSON');
      }

      if (!res.ok) {
        const errObj = json as { error?: string };
        setApiError(errObj.error || 'The preview request could not be completed. Please try again.');
        setIsLoading(false);
        return;
      }

      // Step 13: Strict Client Runtime Response Guard
      const validatedResponse = validateBrowserImportPreviewResponse(json);
      if (!validatedResponse) {
        setApiError('The server returned an invalid or malformed preview response.');
        setIsLoading(false);
        return;
      }

      setPreviewResult(validatedResponse.batch);
    } catch {
      // Step 13: Safe client error handling without raw exception exposure
      setApiError('The preview request could not be completed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearSelection = () => {
    setSelectedFiles([]);
    setSelectedRootName(null);
    setDeclaredTotalBytes(0);
    setDetectedPackageCount(0);
    setPreviewResult(null);
    setApiError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const togglePackageExpand = (pkgPath: string) => {
    setExpandedPackages((prev) => ({ ...prev, [pkgPath]: !prev[pkgPath] }));
  };

  const formatMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', color: '#F3F4F6', fontFamily: 'system-ui, sans-serif' }}>
      {/* Permanent Preview Banners */}
      <div style={{
        backgroundColor: '#1E293B',
        borderRadius: '12px',
        padding: '1.25rem 1.5rem',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        marginBottom: '1.5rem',
      }}>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#60A5FA', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          🔒 Preview only — nothing has been saved
        </div>
        <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.9rem', color: '#9CA3AF', lineHeight: 1.5 }}>
          Selecting a project folder or batch directory parses metadata and validates layout specs entirely in memory.
          Zero database rows are written, zero storage objects are uploaded, and zero public feed records are published.
        </p>
      </div>

      {!isSupported && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.15)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: '12px',
          padding: '1rem 1.25rem',
          marginBottom: '1.5rem',
          color: '#EF4444',
        }}>
          ⚠️ Your current web browser does not support directory folder selection. Please use Chromium, Google Chrome, or Microsoft Edge.
        </div>
      )}

      {/* Selection Control Card */}
      <div style={{
        backgroundColor: '#161F30',
        borderRadius: '12px',
        padding: '1.75rem',
        border: '1px solid rgba(255, 255, 255, 0.05)',
        marginBottom: '2rem',
      }}>
        <h2 style={{ fontSize: '1.1rem', margin: '0 0 1rem 0', color: '#FFFFFF' }}>1. Select Project Folder or Batch Directory</h2>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFolderSelection}
            disabled={isLoading || !isSupported}
            {...({ webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
            style={{ display: 'none' }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || !isSupported}
            style={{
              backgroundColor: '#3B82F6',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '8px',
              padding: '0.75rem 1.5rem',
              fontWeight: 600,
              fontSize: '0.95rem',
              cursor: isLoading || !isSupported ? 'not-allowed' : 'pointer',
              opacity: isLoading || !isSupported ? 0.6 : 1,
            }}
          >
            📁 Choose Project Folder
          </button>

          {selectedFiles.length > 0 && (
            <>
              <button
                type="button"
                onClick={handleRequestPreview}
                disabled={isLoading}
                style={{
                  backgroundColor: '#10B981',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0.75rem 1.5rem',
                  fontWeight: 600,
                  fontSize: '0.95rem',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.6 : 1,
                }}
              >
                {isLoading ? '⏳ Generating Preview...' : '🔍 Generate Batch Preview'}
              </button>

              <button
                type="button"
                onClick={handleClearSelection}
                disabled={isLoading}
                style={{
                  backgroundColor: 'transparent',
                  color: '#9CA3AF',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  padding: '0.75rem 1.25rem',
                  fontSize: '0.9rem',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                }}
              >
                Clear Selection
              </button>
            </>
          )}
        </div>

        {/* Selected Folder Metrics Summary */}
        {selectedRootName && (
          <div style={{
            marginTop: '1.5rem',
            paddingTop: '1.25rem',
            borderTop: '1px solid rgba(255, 255, 255, 0.05)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '1rem',
          }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Root Folder</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: '#60A5FA', marginTop: '0.25rem' }}>{selectedRootName}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Selected Files</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: '#FFFFFF', marginTop: '0.25rem' }}>{selectedFiles.length}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Total Declared Size</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: '#FFFFFF', marginTop: '0.25rem' }}>{formatMB(declaredTotalBytes)} MB</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Detected Packages</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: '#10B981', marginTop: '0.25rem' }}>{detectedPackageCount}</div>
            </div>
          </div>
        )}
      </div>

      {/* API Error Message */}
      {apiError && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: '12px',
          padding: '1.25rem 1.5rem',
          marginBottom: '2rem',
          color: '#EF4444',
        }}>
          <h4 style={{ margin: '0 0 0.5rem 0', fontWeight: 700 }}>Preview Request Failed</h4>
          <p style={{ margin: 0, fontSize: '0.9rem', color: '#D1D5DB' }}>{apiError}</p>
        </div>
      )}

      {/* Preview Results Section */}
      {previewResult && (
        <div>
          {/* Descriptor Mode Banner */}
          <div style={{
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            border: '1px solid rgba(59, 130, 246, 0.2)',
            borderRadius: '12px',
            padding: '1rem 1.25rem',
            marginBottom: '1.5rem',
            color: '#60A5FA',
            fontSize: '0.85rem',
          }}>
            ℹ️ <strong>Media validation mode:</strong> filename, MIME, and declared file-size preview only. Actual media bytes will require validation again during a future import step.
          </div>

          {/* Batch Metrics Cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '1rem',
            marginBottom: '2rem',
          }}>
            <div style={{ backgroundColor: '#161F30', borderRadius: '10px', padding: '1rem', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Import Mode</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#3B82F6', marginTop: '0.25rem', textTransform: 'capitalize' }}>{previewResult.mode}</div>
            </div>
            <div style={{ backgroundColor: '#161F30', borderRadius: '10px', padding: '1rem', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Total Packages</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#FFFFFF', marginTop: '0.25rem' }}>{previewResult.packageCount}</div>
            </div>
            <div style={{ backgroundColor: '#161F30', borderRadius: '10px', padding: '1rem', border: '1px solid rgba(255, 255, 255, 0.05)', borderLeft: '4px solid #10B981' }}>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Valid Packages</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#10B981', marginTop: '0.25rem' }}>{previewResult.validPackageCount}</div>
            </div>
            <div style={{ backgroundColor: '#161F30', borderRadius: '10px', padding: '1rem', border: '1px solid rgba(255, 255, 255, 0.05)', borderLeft: '4px solid #F59E0B' }}>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>With Warnings</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#F59E0B', marginTop: '0.25rem' }}>{previewResult.warningPackageCount}</div>
            </div>
            <div style={{ backgroundColor: '#161F30', borderRadius: '10px', padding: '1rem', border: '1px solid rgba(255, 255, 255, 0.05)', borderLeft: '4px solid #EF4444' }}>
              <div style={{ fontSize: '0.75rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Invalid Packages</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#EF4444', marginTop: '0.25rem' }}>{previewResult.invalidPackageCount}</div>
            </div>
          </div>

          {/* Batch-Level Issues */}
          {previewResult.batchIssues && previewResult.batchIssues.length > 0 && (
            <div style={{
              backgroundColor: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid rgba(245, 158, 11, 0.2)',
              borderRadius: '12px',
              padding: '1rem 1.25rem',
              marginBottom: '1.5rem',
            }}>
              <h4 style={{ margin: '0 0 0.5rem 0', color: '#F59E0B', fontWeight: 700 }}>Batch Root Folder Warnings</h4>
              {previewResult.batchIssues.map((issue, idx) => (
                <div key={`batch-issue-${idx}`} style={{ fontSize: '0.85rem', color: '#D1D5DB' }}>
                  ⚠️ <strong>[{issue.code}]</strong> {issue.message} {issue.fileName && `(file: ${issue.fileName})`}
                </div>
              ))}
            </div>
          )}

          {/* Package Preview List */}
          <h3 style={{ fontSize: '1.2rem', margin: '0 0 1rem 0', color: '#FFFFFF' }}>2. Isolated Package Previews</h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {previewResult.packages.map((pkg) => {
              const isExpanded = expandedPackages[pkg.packagePath] || false;
              const statusColor = pkg.status === 'valid' ? '#10B981' : pkg.status === 'warning' ? '#F59E0B' : '#EF4444';

              return (
                <div
                  key={pkg.packagePath}
                  style={{
                    backgroundColor: '#161F30',
                    borderRadius: '12px',
                    border: '1px solid rgba(255, 255, 255, 0.05)',
                    borderLeft: `4px solid ${statusColor}`,
                    padding: '1.25rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontWeight: 800, fontSize: '1.1rem', color: '#FFFFFF' }}>{pkg.folderName}</span>
                        <span style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.6rem',
                          borderRadius: '12px',
                          backgroundColor: `${statusColor}20`,
                          color: statusColor,
                          border: `1px solid ${statusColor}40`,
                        }}>
                          {pkg.status.toUpperCase()}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#9CA3AF', marginTop: '0.25rem' }}>
                        Public ID: <code style={{ color: '#60A5FA' }}>{pkg.proposedPublicId}</code> | Metadata Source: <strong>{pkg.metadataSource || 'None'}</strong>
                      </div>
                    </div>

                    {(pkg.errors.length > 0 || pkg.warnings.length > 0) && (
                      <button
                        type="button"
                        onClick={() => togglePackageExpand(pkg.packagePath)}
                        style={{
                          backgroundColor: 'rgba(255, 255, 255, 0.05)',
                          color: '#D1D5DB',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '6px',
                          padding: '0.4rem 0.8rem',
                          fontSize: '0.8rem',
                          cursor: 'pointer',
                        }}
                      >
                        {isExpanded ? 'Hide Details' : `Show Issues (${pkg.errors.length}E / ${pkg.warnings.length}W)`}
                      </button>
                    )}
                  </div>

                  {/* Metadata Summary */}
                  {pkg.previewMetadata ? (
                    <div style={{
                      marginTop: '1rem',
                      paddingTop: '0.75rem',
                      borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      gap: '0.75rem',
                      fontSize: '0.85rem',
                    }}>
                      <div><span style={{ color: '#9CA3AF' }}>Title:</span> <strong style={{ color: '#F3F4F6' }}>{pkg.previewMetadata.title}</strong></div>
                      <div><span style={{ color: '#9CA3AF' }}>Year:</span> <strong style={{ color: '#F3F4F6' }}>{pkg.previewMetadata.year}</strong></div>
                      <div><span style={{ color: '#9CA3AF' }}>Program:</span> <strong style={{ color: '#F3F4F6' }}>{pkg.previewMetadata.program}</strong></div>
                      <div><span style={{ color: '#9CA3AF' }}>Discipline:</span> <strong style={{ color: '#F3F4F6' }}>{pkg.previewMetadata.discipline}</strong></div>
                      <div><span style={{ color: '#9CA3AF' }}>Group:</span> <strong style={{ color: '#F3F4F6' }}>{pkg.previewMetadata.groupName}</strong></div>
                      <div><span style={{ color: '#9CA3AF' }}>Roster Count:</span> <strong style={{ color: '#F3F4F6' }}>{pkg.previewMetadata.teamMemberCount} members</strong></div>
                    </div>
                  ) : (
                    <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#EF4444' }}>
                      No valid project metadata parsed for this package.
                    </div>
                  )}

                  {/* File Presence Badges */}
                  <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.75rem' }}>
                    <span style={{ color: pkg.filePresence.posterImagePresent ? '#10B981' : '#EF4444' }}>
                      {pkg.filePresence.posterImagePresent ? '✓' : '✗'} poster.png
                    </span>
                    <span style={{ color: pkg.filePresence.posterPdfPresent ? '#10B981' : '#EF4444' }}>
                      {pkg.filePresence.posterPdfPresent ? '✓' : '✗'} poster.pdf
                    </span>
                    <span style={{ color: pkg.filePresence.snapshotPresent ? '#10B981' : '#F59E0B' }}>
                      {pkg.filePresence.snapshotPresent ? '✓' : '○'} snapshot-1.png
                    </span>
                  </div>

                  {/* Expandable Issues Drawer */}
                  {isExpanded && (
                    <div style={{
                      marginTop: '1rem',
                      paddingTop: '1rem',
                      borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                    }}>
                      {pkg.errors.map((err, idx) => (
                        <div key={`err-${idx}`} style={{ color: '#EF4444', fontSize: '0.85rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem 0.75rem', borderRadius: '6px' }}>
                          <strong>[{err.code}]</strong> {err.message}
                          {err.fieldName && <span style={{ color: '#9CA3AF' }}> (field: {err.fieldName})</span>}
                          {err.fileName && <span style={{ color: '#9CA3AF' }}> (file: {err.fileName})</span>}
                        </div>
                      ))}
                      {pkg.warnings.map((warn, idx) => (
                        <div key={`warn-${idx}`} style={{ color: '#F59E0B', fontSize: '0.85rem', backgroundColor: 'rgba(245, 158, 11, 0.1)', padding: '0.5rem 0.75rem', borderRadius: '6px' }}>
                          <strong>[{warn.code}]</strong> {warn.message}
                          {warn.fieldName && <span style={{ color: '#9CA3AF' }}> (field: {warn.fieldName})</span>}
                          {warn.fileName && <span style={{ color: '#9CA3AF' }}> (file: {warn.fileName})</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
