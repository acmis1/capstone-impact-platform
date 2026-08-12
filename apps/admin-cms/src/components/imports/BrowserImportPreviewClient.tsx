'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import { generateUploadKey, isIgnoredSystemFile, normalizeRelativePath } from '../../import/browserSelection';
import {
  BrowserImportPreviewBatch,
  buildBrowserSelectionDescriptor,
  SelectedFileDescriptor,
  SelectionManifest,
  validateBrowserImportPreviewResponse,
} from '../../import/browserImportPreviewContract';
import {
  BrowserImportSelectionState,
  createInitialSelectionState,
  resetSelectionState,
  toggleValidPackage,
  toggleWarningAcknowledgement,
  toggleWarningPackageSelection,
} from '../../import/browserImportCommitIntentContract';
import { runBrowserImportPreparation } from '../../import/browserImportPreparationController';
import { runBrowserImportMetadataStaging } from '../../import/browserImportStagingController';
import { runBrowserImportMediaStaging } from '../../import/browserImportMediaStagingController';

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
  const [previewResult, setPreviewResult] = useState<BrowserImportPreviewBatch | null>(null);
  const [expandedPackages, setExpandedPackages] = useState<Record<string, boolean>>({});
  const [selectionState, setRawSelectionState] = useState<BrowserImportSelectionState>(resetSelectionState());
  const [manifestCache, setManifestCache] = useState<SelectionManifest | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isStaging, setIsStaging] = useState(false);
  const [stagingError, setStagingError] = useState<string | null>(null);
  const [stagedResult, setStagedResult] = useState<{
    batchId: string;
    projectCount: number;
    warningCount: number;
    result: 'created' | 'already_staged';
  } | null>(null);

  const [isCompletingMedia, setIsCompletingMedia] = useState(false);
  const [mediaCompleteError, setMediaCompleteError] = useState<string | null>(null);
  const [mediaCompleteResult, setMediaCompleteResult] = useState<{
    batchId: string;
    mediaAssetCount: number;
    result: 'completed' | 'already_completed';
  } | null>(null);

  const stagingLockRef = useRef(false);
  const mediaCompleteLockRef = useRef(false);
  const preparationLockRef = useRef(false);
  const selectionStateRef = useRef<BrowserImportSelectionState>(selectionState);

  const updateSelectionState = (
    updater:
      | BrowserImportSelectionState
      | ((previous: BrowserImportSelectionState) => BrowserImportSelectionState)
  ) => {
    setRawSelectionState((previous) => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      selectionStateRef.current = next;
      return next;
    });
  };

  const invalidateStagingResult = () => {
    setStagedResult(null);
    setStagingError(null);
    setMediaCompleteResult(null);
    setMediaCompleteError(null);
  };

  const isPreparingOrLocked = selectionState.isPreparing || isStaging || isCompletingMedia;


  const handleFolderSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (preparationLockRef.current || stagingLockRef.current || selectionStateRef.current.isPreparing || isStaging || isCompletingMedia) return;

    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setSelectedFiles([]);
    setSelectedRootName(null);
    setDeclaredTotalBytes(0);
    setDetectedPackageCount(0);
    setPreviewResult(null);
    setApiError(null);
    invalidateStagingResult();
    updateSelectionState(resetSelectionState());
    setManifestCache(null);

    const descriptors: SelectedFileDescriptor[] = [];
    let totalBytes = 0;

    for (const file of files) {
      const relPath = file.webkitRelativePath || file.name;
      const norm = normalizeRelativePath(relPath);

      if (!norm || isIgnoredSystemFile(norm)) continue;

      totalBytes += file.size;
      const descriptor = buildBrowserSelectionDescriptor(relPath, file.size, file.type);
      if (descriptor) descriptors.push(descriptor);
    }

    if (descriptors.length === 0) {
      setApiError('The selected folder contains no valid project package files.');
      setSelectedFiles([]);
      setSelectedRootName(null);
      return;
    }

    const rootMetadata = descriptors.filter((d) => {
      const norm = d.originalPath;
      const parts = norm.split('/');
      const lower = parts[parts.length - 1].toLowerCase();
      return parts.length === 2 && (lower === 'project-details.xlsx' || lower === 'project.json');
    });
    const childMetadata = descriptors.filter((d) => {
      const norm = d.originalPath;
      const parts = norm.split('/');
      const lower = parts[parts.length - 1].toLowerCase();
      return parts.length === 3 && (lower === 'project-details.xlsx' || lower === 'project.json');
    });

    let mode: 'single' | 'batch' = 'single';
    if (childMetadata.length > 0) {
      mode = 'batch';
    } else if (rootMetadata.length > 0) {
      mode = 'single';
    } else {
      const maxDepth = Math.max(...descriptors.map((d) => d.originalPath.split('/').length));
      mode = maxDepth >= 3 ? 'batch' : 'single';
    }

    const calculatedPackagePaths = new Set<string>();
    for (const desc of descriptors) {
      const norm = desc.originalPath;
      const parts = norm.split('/');
      if (mode === 'single') {
        calculatedPackagePaths.add(parts[0]);
      } else {
        if (parts.length > 2) {
          calculatedPackagePaths.add(`${parts[0]}/${parts[1]}`);
        }
      }
    }

    const firstNorm = descriptors[0].originalPath;
    const rootName = firstNorm.split('/')[0];
    setSelectedFiles(files);
    setSelectedRootName(rootName);
    setDeclaredTotalBytes(totalBytes);
    setDetectedPackageCount(calculatedPackagePaths.size);
  };

  const handleRequestPreview = async () => {
    if (selectedFiles.length === 0 || !selectedRootName || preparationLockRef.current || stagingLockRef.current || selectionStateRef.current.isPreparing || isStaging || isCompletingMedia) return;

    setIsLoading(true);
    setApiError(null);
    setPreviewResult(null);
    setManifestCache(null);
    invalidateStagingResult();
    updateSelectionState(resetSelectionState());

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
        const descriptor = buildBrowserSelectionDescriptor(relPath, file.size, file.type);
        if (!descriptor) continue;
        descriptors.push(descriptor);

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
        const errObj = json as { code?: string; error?: string };
        const knownErrorMap: Record<string, string> = {
          UNAUTHENTICATED: 'Authentication required. Please log in with staff credentials.',
          PERMISSION_DENIED: 'Access denied: You do not have permission to preview imports.',
          AUTH_SERVICE_UNAVAILABLE: 'Authentication service is temporarily unavailable. Please try again.',
          CROSS_ORIGIN_REJECTED: 'Cross-origin requests are forbidden.',
          MISSING_CONTENT_LENGTH: 'A valid Content-Length header is required for this request.',
          INVALID_CONTENT_LENGTH: 'The request Content-Length header is invalid.',
          REQUEST_TOO_LARGE: 'The request size exceeds the maximum limit.',
          INVALID_MANIFEST: 'Selection manifest is invalid or malformed.',
          DUPLICATE_MANIFEST: 'Duplicate manifest field is forbidden.',
          UNEXPECTED_UPLOAD_FIELD: 'Form contains unrecognized upload fields.',
          DUPLICATE_UPLOAD_FIELD: 'Form contains duplicate upload fields.',
          MISSING_METADATA_UPLOAD: 'Missing expected metadata file upload.',
          METADATA_SIZE_MISMATCH: 'Uploaded metadata file size mismatch.',
          METADATA_LIMIT_EXCEEDED: 'Uploaded metadata size or count exceeds maximum limits.',
          UNEXPECTED_INTERNAL_ERROR: 'The preview request could not be completed. Please try again.',
        };
        const msg = (errObj.code && knownErrorMap[errObj.code]) || 'The preview request could not be completed. Please try again.';
        setApiError(msg);
        setIsLoading(false);
        return;
      }

      const validatedResponse = validateBrowserImportPreviewResponse(json);
      if (!validatedResponse) {
        setApiError('The preview request could not be completed. Please try again.');
        setIsLoading(false);
        return;
      }

      setPreviewResult(validatedResponse.batch);
      setManifestCache(manifest);
      updateSelectionState(createInitialSelectionState(validatedResponse.batch));
    } catch {
      setApiError('The preview request could not be completed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearSelection = () => {
    if (preparationLockRef.current || stagingLockRef.current || selectionStateRef.current.isPreparing || isStaging || isCompletingMedia) return;

    setSelectedFiles([]);
    setSelectedRootName(null);
    setDeclaredTotalBytes(0);
    setDetectedPackageCount(0);
    setPreviewResult(null);
    setApiError(null);
    invalidateStagingResult();
    updateSelectionState(resetSelectionState());
    setManifestCache(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleToggleValid = (pkgPath: string) => {
    if (!previewResult || preparationLockRef.current || stagingLockRef.current || selectionStateRef.current.isPreparing || isStaging || isCompletingMedia) return;
    invalidateStagingResult();
    updateSelectionState((prev) => toggleValidPackage(prev, pkgPath, previewResult.packages));
  };

  const handleToggleWarningAck = (pkgPath: string) => {
    if (!previewResult || preparationLockRef.current || stagingLockRef.current || selectionStateRef.current.isPreparing || isStaging || isCompletingMedia) return;
    invalidateStagingResult();
    updateSelectionState((prev) => toggleWarningAcknowledgement(prev, pkgPath, previewResult.packages));
  };

  const handleToggleWarningSelect = (pkgPath: string) => {
    if (!previewResult || preparationLockRef.current || stagingLockRef.current || selectionStateRef.current.isPreparing || isStaging || isCompletingMedia) return;
    invalidateStagingResult();
    updateSelectionState((prev) => toggleWarningPackageSelection(prev, pkgPath, previewResult.packages));
  };

  const handlePrepareImport = async () => {
    if (!previewResult || !manifestCache || preparationLockRef.current || stagingLockRef.current || selectionStateRef.current.isPreparing || isStaging || isCompletingMedia) return;
    invalidateStagingResult();

    await runBrowserImportPreparation({
      lock: preparationLockRef,
      currentState: selectionStateRef.current,
      previewResult,
      manifestCache,
      getCurrentState: () => selectionStateRef.current,
      setSelectionState: updateSelectionState,
    });
  };

  const handleStageMetadata = async () => {
    await runBrowserImportMetadataStaging({
      lock: stagingLockRef,
      isStaging,
      preparedIntent: selectionStateRef.current.preparedIntent,
      manifestCache,
      selectedFiles,
      setIsStaging,
      setStagingError,
      setStagedResult,
    });
  };

  const handleCompleteMedia = async () => {
    if (!stagedResult) return;
    await runBrowserImportMediaStaging({
      lock: mediaCompleteLockRef,
      isCompletingMedia,
      batchId: stagedResult.batchId,
      preparedIntent: selectionStateRef.current.preparedIntent,
      manifestCache,
      selectedPackagePaths: selectionStateRef.current.selectedPackagePaths,
      selectedFiles,
      setIsCompletingMedia,
      setMediaCompleteError,
      setMediaCompleteResult,
    });
  };

  const togglePackageExpand = (pkgPath: string) => {
    setExpandedPackages((prev) => ({ ...prev, [pkgPath]: !prev[pkgPath] }));
  };

  const formatMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

  // Derived counts for package selection header
  const totalSelectedCount = selectionState.selectedPackagePaths.length;
  const selectedValidCount = previewResult
    ? previewResult.packages.filter((p) => p.status === 'valid' && selectionState.selectedPackagePaths.includes(p.packagePath)).length
    : 0;
  const selectedWarningCount = previewResult
    ? previewResult.packages.filter((p) => p.status === 'warning' && selectionState.selectedPackagePaths.includes(p.packagePath)).length
    : 0;
  const unacknowledgedWarningCount = previewResult
    ? previewResult.packages.filter((p) => p.status === 'warning' && !selectionState.acknowledgedWarningPackagePaths.includes(p.packagePath)).length
    : 0;

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
            disabled={isLoading || !isSupported || isPreparingOrLocked}
            {...({ webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
            style={{ display: 'none' }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || !isSupported || isPreparingOrLocked}
            style={{
              backgroundColor: '#3B82F6',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '8px',
              padding: '0.75rem 1.5rem',
              fontWeight: 600,
              fontSize: '0.95rem',
              cursor: isLoading || !isSupported || isPreparingOrLocked ? 'not-allowed' : 'pointer',
              opacity: isLoading || !isSupported || isPreparingOrLocked ? 0.6 : 1,
            }}
          >
            📁 Choose Project Folder
          </button>

          {selectedFiles.length > 0 && (
            <>
              <button
                type="button"
                onClick={handleRequestPreview}
                disabled={isLoading || isPreparingOrLocked}
                style={{
                  backgroundColor: '#10B981',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0.75rem 1.5rem',
                  fontWeight: 600,
                  fontSize: '0.95rem',
                  cursor: isLoading || isPreparingOrLocked ? 'not-allowed' : 'pointer',
                  opacity: isLoading || isPreparingOrLocked ? 0.6 : 1,
                }}
              >
                {isLoading ? '⏳ Generating Preview...' : '🔍 Generate Batch Preview'}
              </button>

              <button
                type="button"
                onClick={handleClearSelection}
                disabled={isLoading || isPreparingOrLocked}
                style={{
                  backgroundColor: 'transparent',
                  color: '#9CA3AF',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  padding: '0.75rem 1.25rem',
                  fontSize: '0.9rem',
                  cursor: isLoading || isPreparingOrLocked ? 'not-allowed' : 'pointer',
                  opacity: isLoading || isPreparingOrLocked ? 0.6 : 1,
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

          {/* Package Selection Controls & Action Bar */}
          <div style={{
            backgroundColor: '#161F30',
            borderRadius: '12px',
            padding: '1.25rem 1.5rem',
            border: '1px solid rgba(255, 255, 255, 0.05)',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '1rem',
          }}>
            <div>
              <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#FFFFFF' }}>
                Package Selection ({totalSelectedCount} selected: {selectedValidCount} valid, {selectedWarningCount} warning)
              </div>
              <div style={{ fontSize: '0.8rem', color: '#9CA3AF', marginTop: '0.25rem' }}>
                {unacknowledgedWarningCount > 0
                  ? `⚠️ ${unacknowledgedWarningCount} warning package(s) awaiting acknowledgement`
                  : '✓ All warning packages acknowledged or excluded'}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.8rem', color: '#9CA3AF', fontStyle: 'italic' }}>
                Preparation only — no projects or files will be saved.
              </div>

              <button
                type="button"
                onClick={handlePrepareImport}
                disabled={selectionState.isPreparing || totalSelectedCount === 0}
                style={{
                  backgroundColor: '#8B5CF6',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0.65rem 1.25rem',
                  fontWeight: 700,
                  fontSize: '0.9rem',
                  cursor: selectionState.isPreparing || totalSelectedCount === 0 ? 'not-allowed' : 'pointer',
                  opacity: selectionState.isPreparing || totalSelectedCount === 0 ? 0.5 : 1,
                }}
              >
                {selectionState.isPreparing ? '⏳ Preparing...' : 'Prepare Import'}
              </button>
            </div>
          </div>

          {/* Preparation Error Feedback */}
          {selectionState.preparationErrorCode && (
            <div style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: '10px',
              padding: '1rem 1.25rem',
              marginBottom: '1.5rem',
              color: '#EF4444',
              fontSize: '0.9rem',
            }}>
              ❌ <strong>Import preparation failed:</strong>{' '}
              {selectionState.preparationErrorCode === 'EMPTY_SELECTION'
                ? 'At least one package must be selected.'
                : selectionState.preparationErrorCode === 'PREVIEW_FINGERPRINT_MISMATCH'
                  ? 'Preview state has changed or fingerprint does not match.'
                  : 'The selection could not be prepared as an import intent. Please check acknowledgements and try again.'}
            </div>
          )}

          {/* Prepared Intent Summary Card */}
          {selectionState.preparedIntent && (
            <div style={{
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              borderRadius: '12px',
              padding: '1.25rem 1.5rem',
              marginBottom: '1.5rem',
              color: '#10B981',
            }}>
              <h4 style={{ margin: '0 0 0.5rem 0', fontWeight: 800, fontSize: '1rem', color: '#10B981' }}>
                ✓ Import Intent Prepared Successfully
              </h4>
              <p style={{ margin: '0 0 1rem 0', fontSize: '0.85rem', color: '#D1D5DB' }}>
                A deterministic import intent contract has been constructed in memory for future persistence. No database or storage writes occurred.
              </p>

              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '0.75rem',
                fontSize: '0.85rem',
                backgroundColor: '#161F30',
                padding: '1rem',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.05)',
              }}>
                <div><span style={{ color: '#9CA3AF' }}>Fingerprint:</span> <code style={{ color: '#60A5FA' }}>{selectionState.preparedIntent.previewFingerprint.slice(0, 12)}...</code></div>
                <div><span style={{ color: '#9CA3AF' }}>Selected Root:</span> <strong style={{ color: '#F3F4F6' }}>{selectionState.preparedIntent.selectedRootName}</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Selected Package Count:</span> <strong style={{ color: '#F3F4F6' }}>{selectionState.preparedIntent.selectedPackagePaths.length}</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Selected Valid Count:</span> <strong style={{ color: '#F3F4F6' }}>{selectionState.preparedIntent.selectedPackagePaths.filter((p) => previewResult.packages.find((pkg) => pkg.packagePath === p)?.status === 'valid').length}</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Selected Warning Count:</span> <strong style={{ color: '#F3F4F6' }}>{selectionState.preparedIntent.selectedPackagePaths.filter((p) => previewResult.packages.find((pkg) => pkg.packagePath === p)?.status === 'warning').length}</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Declared File Count:</span> <strong style={{ color: '#F3F4F6' }}>{selectionState.preparedIntent.fileCount}</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Declared Total Bytes:</span> <strong style={{ color: '#F3F4F6' }}>{formatMB(selectionState.preparedIntent.declaredTotalBytes)} MB</strong></div>
                {selectionState.preparedIntent.acknowledgedWarningPackagePaths.length > selectionState.preparedIntent.selectedPackagePaths.filter((p) => previewResult.packages.find((pkg) => pkg.packagePath === p)?.status === 'warning').length && (
                  <div><span style={{ color: '#9CA3AF' }}>Acknowledged Unselected Warnings:</span> <strong style={{ color: '#F3F4F6' }}>{selectionState.preparedIntent.acknowledgedWarningPackagePaths.length - selectionState.preparedIntent.selectedPackagePaths.filter((p) => previewResult.packages.find((pkg) => pkg.packagePath === p)?.status === 'warning').length}</strong></div>
                )}
              </div>

              <div style={{
                marginTop: '1.25rem',
                paddingTop: '1rem',
                borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '1rem',
              }}>
                <div style={{ fontSize: '0.8rem', color: '#9CA3AF' }}>
                  ℹ️ This creates draft project metadata and an import batch. Media files are not uploaded in this step.
                </div>

                <button
                  type="button"
                  onClick={handleStageMetadata}
                  disabled={isStaging || selectionState.isPreparing || isCompletingMedia}
                  style={{
                    backgroundColor: '#10B981',
                    color: '#FFFFFF',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '0.65rem 1.25rem',
                    fontWeight: 700,
                    fontSize: '0.9rem',
                    cursor: isStaging || selectionState.isPreparing || isCompletingMedia ? 'not-allowed' : 'pointer',
                    opacity: isStaging || selectionState.isPreparing || isCompletingMedia ? 0.5 : 1,
                  }}
                >
                  {isStaging ? '⏳ Staging Metadata...' : '💾 Stage Selected Metadata'}
                </button>
              </div>
            </div>
          )}

          {/* Staging Failure Feedback */}
          {stagingError && (
            <div style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: '10px',
              padding: '1rem 1.25rem',
              marginBottom: '1.5rem',
              color: '#EF4444',
              fontSize: '0.9rem',
            }}>
              ❌ <strong>Metadata Staging Failed:</strong> {stagingError}
            </div>
          )}

          {/* Staged Success Card */}
          {stagedResult && (
            <div style={{
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              borderRadius: '12px',
              padding: '1.25rem 1.5rem',
              marginBottom: '1.5rem',
              color: '#60A5FA',
            }}>
              <h4 style={{ margin: '0 0 0.5rem 0', fontWeight: 800, fontSize: '1rem', color: '#60A5FA' }}>
                🎉 {stagedResult.result === 'already_staged' ? 'Import Batch Already Staged (Idempotent Retry)' : 'Import Metadata Staged Successfully'}
              </h4>
              <p style={{ margin: '0 0 1rem 0', fontSize: '0.85rem', color: '#D1D5DB' }}>
                Draft project metadata and batch record have been atomically created in local Supabase. Upload the selected packages&apos; media below to complete the import.
              </p>

              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '0.75rem',
                fontSize: '0.85rem',
                backgroundColor: '#161F30',
                padding: '1rem',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.05)',
                marginBottom: '1rem',
              }}>
                <div><span style={{ color: '#9CA3AF' }}>Batch Status:</span> <strong style={{ color: '#A78BFA' }}>metadata_staged</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Staged Projects:</span> <strong style={{ color: '#F3F4F6' }}>{stagedResult.projectCount} draft(s)</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Warnings Logged:</span> <strong style={{ color: '#F3F4F6' }}>{stagedResult.warningCount}</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Batch UUID:</span> <code style={{ color: '#E5E7EB' }}>{stagedResult.batchId}</code></div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <Link
                  href={`/admin/imports/${stagedResult.batchId}`}
                  style={{
                    color: '#FFFFFF',
                    backgroundColor: '#3B82F6',
                    textDecoration: 'none',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                    padding: '0.5rem 1rem',
                    borderRadius: '6px',
                    display: 'inline-block',
                  }}
                >
                  View Import Batch Detail Page →
                </Link>
              </div>
            </div>
          )}

          {/* Media Completion Action Card */}
          {stagedResult && !mediaCompleteResult && (
            <div style={{
              backgroundColor: '#111827',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '1.25rem 1.5rem',
              marginBottom: '1.5rem',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '1rem',
              }}>
                <div style={{ fontSize: '0.8rem', color: '#9CA3AF' }}>
                  ℹ️ Uploads poster/PDF/snapshot media for the selected packages into private draft storage and completes the import batch. Nothing is made public.
                </div>

                <button
                  type="button"
                  onClick={handleCompleteMedia}
                  disabled={isCompletingMedia}
                  style={{
                    backgroundColor: '#3B82F6',
                    color: '#FFFFFF',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '0.65rem 1.25rem',
                    fontWeight: 700,
                    fontSize: '0.9rem',
                    cursor: isCompletingMedia ? 'not-allowed' : 'pointer',
                    opacity: isCompletingMedia ? 0.5 : 1,
                  }}
                >
                  {isCompletingMedia ? '⏳ Uploading Media...' : '📤 Upload Media & Complete Import'}
                </button>
              </div>
            </div>
          )}

          {/* Media Completion Failure Feedback */}
          {mediaCompleteError && (
            <div style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: '10px',
              padding: '1rem 1.25rem',
              marginBottom: '1.5rem',
              color: '#EF4444',
              fontSize: '0.9rem',
            }}>
              ❌ <strong>Media Upload Failed:</strong> {mediaCompleteError} You can safely retry without re-staging metadata.
            </div>
          )}

          {/* Media Completion Success Card */}
          {mediaCompleteResult && (
            <div style={{
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              borderRadius: '12px',
              padding: '1.25rem 1.5rem',
              marginBottom: '1.5rem',
              color: '#10B981',
            }}>
              <h4 style={{ margin: '0 0 0.5rem 0', fontWeight: 800, fontSize: '1rem', color: '#10B981' }}>
                ✅ {mediaCompleteResult.result === 'already_completed' ? 'Import Already Completed (Idempotent Retry)' : 'Import Completed Successfully'}
              </h4>
              <p style={{ margin: '0 0 1rem 0', fontSize: '0.85rem', color: '#D1D5DB' }}>
                Media files were uploaded to private draft storage and registered. Projects remain in draft status.
              </p>

              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '0.75rem',
                fontSize: '0.85rem',
                backgroundColor: '#161F30',
                padding: '1rem',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.05)',
                marginBottom: '1rem',
              }}>
                <div><span style={{ color: '#9CA3AF' }}>Batch Status:</span> <strong style={{ color: '#10B981' }}>completed</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Media Assets Registered:</span> <strong style={{ color: '#F3F4F6' }}>{mediaCompleteResult.mediaAssetCount}</strong></div>
                <div><span style={{ color: '#9CA3AF' }}>Batch UUID:</span> <code style={{ color: '#E5E7EB' }}>{mediaCompleteResult.batchId}</code></div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <Link
                  href={`/admin/imports/${mediaCompleteResult.batchId}`}
                  style={{
                    color: '#FFFFFF',
                    backgroundColor: '#10B981',
                    textDecoration: 'none',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                    padding: '0.5rem 1rem',
                    borderRadius: '6px',
                    display: 'inline-block',
                  }}
                >
                  View Completed Import Batch →
                </Link>
              </div>
            </div>
          )}

          {/* Package Preview List */}
          <h3 style={{ fontSize: '1.2rem', margin: '0 0 1rem 0', color: '#FFFFFF' }}>2. Isolated Package Previews</h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {previewResult.packages.map((pkg) => {
              const isExpanded = expandedPackages[pkg.packagePath] || false;
              const statusColor = pkg.status === 'valid' ? '#10B981' : pkg.status === 'warning' ? '#F59E0B' : '#EF4444';

              const isSelected = selectionState.selectedPackagePaths.includes(pkg.packagePath);
              const isAcked = selectionState.acknowledgedWarningPackagePaths.includes(pkg.packagePath);

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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      {/* Package Selection Controls */}
                      {pkg.status === 'valid' && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: isPreparingOrLocked ? 'not-allowed' : 'pointer', opacity: isPreparingOrLocked ? 0.5 : 1 }}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={isPreparingOrLocked}
                            onChange={() => handleToggleValid(pkg.packagePath)}
                            aria-label={`Select package ${pkg.folderName} for import`}
                            style={{ width: '1.1rem', height: '1.1rem', cursor: isPreparingOrLocked ? 'not-allowed' : 'pointer' }}
                          />
                          <span style={{ fontSize: '0.8rem', color: '#9CA3AF' }}>Select</span>
                        </label>
                      )}

                      {pkg.status === 'warning' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: isPreparingOrLocked ? 'not-allowed' : 'pointer', opacity: isPreparingOrLocked ? 0.5 : 1 }}>
                            <input
                              type="checkbox"
                              checked={isAcked}
                              disabled={isPreparingOrLocked}
                              onChange={() => handleToggleWarningAck(pkg.packagePath)}
                              aria-label={`Acknowledge warnings for package ${pkg.folderName}`}
                              style={{ width: '1rem', height: '1rem', cursor: isPreparingOrLocked ? 'not-allowed' : 'pointer' }}
                            />
                            <span style={{ fontSize: '0.8rem', color: '#F59E0B' }}>Ack Warnings</span>
                          </label>

                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: isAcked && !isPreparingOrLocked ? 'pointer' : 'not-allowed', opacity: isAcked && !isPreparingOrLocked ? 1 : 0.4 }}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={!isAcked || isPreparingOrLocked}
                              onChange={() => handleToggleWarningSelect(pkg.packagePath)}
                              aria-label={`Select warning package ${pkg.folderName} for import after acknowledgement`}
                              style={{ width: '1rem', height: '1rem', cursor: isAcked && !isPreparingOrLocked ? 'pointer' : 'not-allowed' }}
                            />
                            <span style={{ fontSize: '0.8rem', color: isAcked ? '#FFFFFF' : '#9CA3AF' }}>Select</span>
                          </label>
                        </div>
                      )}

                      {pkg.status === 'invalid' && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: 0.4, cursor: 'not-allowed' }}>
                          <input
                            type="checkbox"
                            checked={false}
                            disabled
                            aria-label={`Package ${pkg.folderName} is invalid and cannot be selected`}
                            style={{ width: '1.1rem', height: '1.1rem', cursor: 'not-allowed' }}
                          />
                          <span style={{ fontSize: '0.8rem', color: '#EF4444' }}>Invalid (Disabled)</span>
                        </label>
                      )}

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
