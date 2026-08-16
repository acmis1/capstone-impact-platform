'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import {
  FolderOpen,
  Search,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Layers,
  FileCheck,
  Upload,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CheckSquare,
  ShieldCheck,
} from 'lucide-react';
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
import { AdminReferenceDatasetSection } from './AdminReferenceDatasetSection';
import { ImportWorkflowGuide } from './ImportWorkflowGuide';
import type { AdminReferenceMappingConfig } from '../../import/adminReferenceSharedContract';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Alert } from '../ui/alert';
import { Badge } from '../ui/badge';

export default function BrowserImportPreviewClient() {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [adminReferenceData, setAdminReferenceData] = useState<{
    referenceFile: File;
    mappingConfig: AdminReferenceMappingConfig;
  } | null>(null);
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
      setApiError('The selected folder contains no valid project files.');
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

      if (adminReferenceData) {
        formData.append('referenceFile', adminReferenceData.referenceFile);
        formData.append('adminReferenceMapping', JSON.stringify(adminReferenceData.mappingConfig));
      }

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
      adminReferenceFile: adminReferenceData?.referenceFile,
      adminReferenceMappingConfig: adminReferenceData?.mappingConfig,
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
      adminReferenceFile: adminReferenceData?.referenceFile,
      adminReferenceMappingConfig: adminReferenceData?.mappingConfig,
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

  // Determine current active workflow step for orientation
  let currentStep: 1 | 2 | 3 | 4 | 5 = 1;
  if (mediaCompleteResult || stagedResult) {
    currentStep = 5;
  } else if (previewResult) {
    currentStep = 4;
  } else if (selectedRootName || adminReferenceData) {
    currentStep = 3;
  } else {
    currentStep = 2;
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full">
      {/* Workflow Steps Indicator & Onboarding Guide */}
      <ImportWorkflowGuide currentStep={currentStep} />

      {/* Browser Support Check Warning */}
      {!isSupported && (
        <Alert
          variant="destructive"
          title="Unsupported Browser"
          description="Folder selection is not supported by your current browser. Please use Google Chrome, Microsoft Edge, or another modern Chromium browser to import project folders."
        />
      )}

      {/* Step 2: Admin Reference Dataset Section */}
      <AdminReferenceDatasetSection
        onMappingConfigured={(data) => {
          setAdminReferenceData(data);
          setPreviewResult(null);
          setManifestCache(null);
          invalidateStagingResult();
          updateSelectionState(resetSelectionState());
        }}
        disabled={isPreparingOrLocked}
      />

      {/* Step 3: Choose project folder */}
      <Card className="bg-card border-border shadow-xs">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-primary" aria-hidden="true" />
            <CardTitle className="text-sm font-semibold text-foreground">
              Choose project folder
            </CardTitle>
          </div>
          <CardDescription className="text-xs text-muted-foreground">
            Choose one project folder, or choose a parent folder that contains several project folders.
          </CardDescription>
        </CardHeader>

        <CardContent className="p-4 sm:p-6 flex flex-col gap-5">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFolderSelection}
            disabled={isLoading || !isSupported || isPreparingOrLocked}
            {...({ webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
            className="hidden"
            aria-label="Upload project directory"
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || !isSupported || isPreparingOrLocked}
              className="font-semibold"
            >
              <FolderOpen className="h-4 w-4 mr-2" aria-hidden="true" />
              {selectedFiles.length > 0 ? 'Change project folder' : 'Choose project folder'}
            </Button>

            {selectedFiles.length > 0 && (
              <>
                <Button
                  type="button"
                  onClick={handleRequestPreview}
                  disabled={isLoading || isPreparingOrLocked}
                  className="bg-primary hover:bg-primary/90 font-semibold"
                >
                  <Search className="h-4 w-4 mr-2" aria-hidden="true" />
                  {isLoading ? 'Checking files…' : 'Check project files'}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClearSelection}
                  disabled={isLoading || isPreparingOrLocked}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                  Clear selection
                </Button>
              </>
            )}
          </div>

          {/* Selected Folder Metrics Summary */}
          {selectedRootName && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 rounded-lg bg-muted/40 border border-border text-xs">
              <div>
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                  Selected folder
                </span>
                <span className="font-semibold text-foreground truncate block mt-0.5" title={selectedRootName}>
                  {selectedRootName}
                </span>
              </div>
              <div>
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                  Projects detected
                </span>
                <span className="font-semibold text-foreground block mt-0.5">
                  {detectedPackageCount}
                </span>
              </div>
              <div>
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                  Files selected
                </span>
                <span className="font-semibold text-foreground block mt-0.5">
                  {selectedFiles.length}
                </span>
              </div>
              <div>
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                  Total size
                </span>
                <span className="font-semibold text-foreground block mt-0.5">
                  {formatMB(declaredTotalBytes)} MB
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* API Error Message */}
      {apiError && (
        <Alert
          variant="destructive"
          title="File Check Failed"
          description={apiError}
        />
      )}

      {/* Preview & Validation Results Section */}
      {previewResult && (
        <div className="flex flex-col gap-6">
          {/* Validation Results Card */}
          <Card className="bg-card border-border shadow-xs">
            <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
              <div className="flex items-center gap-2">
                <FileCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                <CardTitle className="text-sm font-semibold text-foreground">
                  Validation results
                </CardTitle>
              </div>
              <CardDescription className="text-xs text-muted-foreground">
                Review check results below. Projects with blocking issues cannot be imported until resolved.
              </CardDescription>
            </CardHeader>

            <CardContent className="p-4 sm:p-6 flex flex-col gap-5">
              {/* Batch Metrics Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-card border border-border shadow-xs">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                    Total projects
                  </span>
                  <span className="text-xl font-bold text-foreground block mt-1">
                    {previewResult.packageCount}
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-card border border-border shadow-xs">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                    Ready to import
                  </span>
                  <span className="text-xl font-bold text-success block mt-1">
                    {previewResult.validPackageCount}
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-card border border-border shadow-xs">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                    With warnings
                  </span>
                  <span className="text-xl font-bold text-warning block mt-1">
                    {previewResult.warningPackageCount}
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-card border border-border shadow-xs">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
                    Needs attention
                  </span>
                  <span className="text-xl font-bold text-destructive block mt-1">
                    {previewResult.invalidPackageCount}
                  </span>
                </div>
              </div>

              {/* Validation Status Legend */}
              <div className="flex flex-wrap items-center gap-4 text-xs p-2.5 rounded-md bg-muted/40 border border-border text-muted-foreground">
                <span className="font-semibold text-foreground">Status key:</span>
                <span className="inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  <strong className="text-foreground font-medium">Ready:</strong> No blocking issues found
                </span>
                <span className="inline-flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
                  <strong className="text-foreground font-medium">Warning:</strong> Importable after acknowledgement
                </span>
                <span className="inline-flex items-center gap-1">
                  <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                  <strong className="text-foreground font-medium">Needs attention:</strong> Blocking issues must be fixed
                </span>
              </div>

              {/* Batch-Level Issues Banner */}
              {previewResult.batchIssues && previewResult.batchIssues.length > 0 && (
                <div className="p-3.5 rounded-lg bg-warning/10 border border-warning/30 text-xs flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 font-semibold text-warning">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    <span>Batch Folder Warnings</span>
                  </div>
                  {previewResult.batchIssues.map((issue, idx) => (
                    <p key={`batch-issue-${idx}`} className="text-foreground text-[11px]">
                      {issue.message} {issue.fileName && `(file: ${issue.fileName})`}
                    </p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Project Packages List Section (Reviewed BEFORE Prepare Import) */}
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-foreground">
              Projects in this folder ({previewResult.packages.length})
            </h3>

            <div className="flex flex-col gap-3">
              {previewResult.packages.map((pkg) => {
                const isExpanded = expandedPackages[pkg.packagePath] || false;
                const isSelected = selectionState.selectedPackagePaths.includes(pkg.packagePath);
                const isAcked = selectionState.acknowledgedWarningPackagePaths.includes(pkg.packagePath);

                return (
                  <Card
                    key={pkg.packagePath}
                    className={`bg-card border-border shadow-xs transition-colors ${
                      pkg.status === 'invalid'
                        ? 'opacity-85 border-destructive/30'
                        : pkg.status === 'warning'
                          ? 'border-warning/30'
                          : 'border-border'
                    }`}
                  >
                    <CardContent className="p-4 sm:p-5 flex flex-col gap-3">
                      {/* Top Header Row */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-start sm:items-center gap-3">
                          {/* Selection Checkbox by Status */}
                          {pkg.status === 'valid' && (
                            <label className="flex items-center gap-2 cursor-pointer select-none mt-0.5 sm:mt-0">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                disabled={isPreparingOrLocked}
                                onChange={() => handleToggleValid(pkg.packagePath)}
                                aria-label={`Select package ${pkg.folderName} for import`}
                                className="h-4 w-4 rounded border-input text-primary focus:ring-ring disabled:opacity-50 cursor-pointer"
                              />
                              <span className="text-xs text-muted-foreground font-medium">Select</span>
                            </label>
                          )}

                          {pkg.status === 'warning' && (
                            <div className="flex items-center gap-3 select-none">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={isAcked}
                                  disabled={isPreparingOrLocked}
                                  onChange={() => handleToggleWarningAck(pkg.packagePath)}
                                  aria-label={`Acknowledge warnings for package ${pkg.folderName}`}
                                  className="h-4 w-4 rounded border-input text-warning focus:ring-ring disabled:opacity-50 cursor-pointer"
                                />
                                <span className="text-xs text-warning font-semibold">Acknowledge warning</span>
                              </label>

                              <label className={`flex items-center gap-1.5 ${isAcked && !isPreparingOrLocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  disabled={!isAcked || isPreparingOrLocked}
                                  onChange={() => handleToggleWarningSelect(pkg.packagePath)}
                                  aria-label={`Select warning package ${pkg.folderName} for import after acknowledgement`}
                                  className="h-4 w-4 rounded border-input text-primary focus:ring-ring disabled:opacity-50"
                                />
                                <span className="text-xs text-muted-foreground font-medium">Select</span>
                              </label>
                            </div>
                          )}

                          {pkg.status === 'invalid' && (
                            <div className="flex items-center gap-1.5 opacity-50 cursor-not-allowed select-none">
                              <input
                                type="checkbox"
                                checked={false}
                                disabled
                                aria-label={`Package ${pkg.folderName} is invalid and cannot be selected`}
                                className="h-4 w-4 rounded border-input cursor-not-allowed"
                              />
                              <span className="text-xs text-destructive font-medium">Cannot import</span>
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-foreground text-sm">
                              {pkg.folderName}
                            </span>

                            {pkg.status === 'valid' ? (
                              <Badge variant="success" className="text-[11px]">
                                <CheckCircle2 className="h-3 w-3 mr-1" aria-hidden="true" />
                                Ready
                                <span className="sr-only">{pkg.status.toUpperCase()}</span>
                              </Badge>
                            ) : pkg.status === 'warning' ? (
                              <Badge variant="warning" className="text-[11px]">
                                <AlertTriangle className="h-3 w-3 mr-1" aria-hidden="true" />
                                Warning
                                <span className="sr-only">{pkg.status.toUpperCase()}</span>
                              </Badge>
                            ) : (
                              <Badge variant="destructive" className="text-[11px]">
                                <XCircle className="h-3 w-3 mr-1" aria-hidden="true" />
                                Needs attention
                                <span className="sr-only">{pkg.status.toUpperCase()}</span>
                              </Badge>
                            )}

                            {/* Reference Reconciliation Status Badge */}
                            {pkg.reconciliation && (
                              <Badge
                                variant={pkg.reconciliation.status === 'RECONCILED' ? 'success' : 'neutral'}
                                className="text-[11px]"
                              >
                                {pkg.reconciliation.status === 'RECONCILED' ? (
                                  <>
                                    <ShieldCheck className="h-3 w-3 mr-1" aria-hidden="true" />
                                    Matched in reference (Row #{pkg.reconciliation.matchedRowNumber})
                                  </>
                                ) : pkg.reconciliation.status === 'ADMIN_REFERENCE_FIELD_MISMATCH' ? (
                                  `Mismatch (${pkg.reconciliation.mismatchedFields.join(', ')})`
                                ) : pkg.reconciliation.status === 'ADMIN_REFERENCE_NO_MATCH' ? (
                                  'Not found in reference'
                                ) : pkg.reconciliation.status === 'ADMIN_REFERENCE_AMBIGUOUS_MATCH' ? (
                                  'Ambiguous reference match'
                                ) : (
                                  'Invalid match key'
                                )}
                              </Badge>
                            )}
                          </div>
                        </div>

                        {(pkg.errors.length > 0 || pkg.warnings.length > 0) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => togglePackageExpand(pkg.packagePath)}
                            className="h-8 text-xs text-muted-foreground hover:text-foreground shrink-0"
                          >
                            {isExpanded ? (
                              <>
                                <span>Hide issues</span>
                                <ChevronDown className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
                              </>
                            ) : (
                              <>
                                <span>Show issues ({pkg.errors.length} error{pkg.errors.length !== 1 ? 's' : ''}, {pkg.warnings.length} warning{pkg.warnings.length !== 1 ? 's' : ''})</span>
                                <ChevronRight className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
                              </>
                            )}
                          </Button>
                        )}
                      </div>

                      {/* Metadata Summary Details Grid */}
                      {pkg.previewMetadata ? (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-border text-xs text-muted-foreground">
                          <div>
                            <span className="text-[11px] block text-muted-foreground">Title:</span>
                            <span className="font-semibold text-foreground truncate block">{pkg.previewMetadata.title}</span>
                          </div>
                          <div>
                            <span className="text-[11px] block text-muted-foreground">Program & Discipline:</span>
                            <span className="text-foreground truncate block">{pkg.previewMetadata.program} · {pkg.previewMetadata.discipline}</span>
                          </div>
                          <div>
                            <span className="text-[11px] block text-muted-foreground">Group name:</span>
                            <span className="text-foreground truncate block">{pkg.previewMetadata.groupName}</span>
                          </div>
                          <div>
                            <span className="text-[11px] block text-muted-foreground">Roster:</span>
                            <span className="text-foreground truncate block">{pkg.previewMetadata.teamMemberCount} member(s)</span>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-destructive pt-1">
                          No project details spreadsheet could be parsed for this project.
                        </div>
                      )}

                      {/* Media File Presence Indicators */}
                      <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground text-[11px]">Media files:</span>
                        <span className="inline-flex items-center gap-1">
                          {pkg.filePresence.posterImagePresent ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                          )}
                          poster.png
                        </span>
                        <span className="inline-flex items-center gap-1">
                          {pkg.filePresence.posterPdfPresent ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                          )}
                          poster.pdf
                        </span>
                        <span className="inline-flex items-center gap-1">
                          {pkg.filePresence.snapshotPresent ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                          ) : (
                            <span className="text-muted-foreground">○</span>
                          )}
                          snapshot-1.png {pkg.filePresence.snapshotPresent ? '' : '(optional)'}
                        </span>
                      </div>

                      {/* Expandable Issues Drawer */}
                      {isExpanded && (
                        <div className="flex flex-col gap-2 pt-2 border-t border-border text-xs">
                          {pkg.errors.map((err, idx) => (
                            <div
                              key={`err-${idx}`}
                              className="p-2.5 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-[11px] leading-relaxed"
                            >
                              <strong>Issue:</strong> {err.message}
                              {err.fieldName && <span className="text-muted-foreground"> (field: {err.fieldName})</span>}
                              {err.fileName && <span className="text-muted-foreground"> (file: {err.fileName})</span>}
                            </div>
                          ))}
                          {pkg.warnings.map((warn, idx) => (
                            <div
                              key={`warn-${idx}`}
                              className="p-2.5 rounded-md bg-warning/10 border border-warning/20 text-warning text-[11px] leading-relaxed"
                            >
                              <strong>Warning:</strong> {warn.message}
                              {warn.fieldName && <span className="text-muted-foreground"> (field: {warn.fieldName})</span>}
                              {warn.fileName && <span className="text-muted-foreground"> (file: {warn.fileName})</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>

          {/* Package Selection Controls & Prepare Import Action Toolbar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg bg-muted/50 border border-border">
            <div className="flex flex-col gap-0.5">
              <div className="text-xs font-semibold text-foreground">
                Project selection: {totalSelectedCount} of {previewResult.packageCount} selected ({selectedValidCount} ready, {selectedWarningCount} warning)
              </div>
              <div className="text-[11px] text-muted-foreground">
                {unacknowledgedWarningCount > 0
                  ? `${unacknowledgedWarningCount} warning project(s) require acknowledgement before import`
                  : 'All selected projects are ready for preparation'}
              </div>
            </div>

            <Button
              type="button"
              size="sm"
              onClick={handlePrepareImport}
              disabled={selectionState.isPreparing || totalSelectedCount === 0}
              className="font-semibold shrink-0"
            >
              <CheckSquare className="h-4 w-4 mr-1.5" aria-hidden="true" />
              {selectionState.isPreparing ? 'Preparing import…' : 'Prepare import'}
            </Button>
          </div>

          {/* Preparation Error Feedback */}
          {selectionState.preparationErrorCode && (
            <Alert
              variant="destructive"
              title="Import Preparation Failed"
              description={
                selectionState.preparationErrorCode === 'EMPTY_SELECTION'
                  ? 'At least one project must be selected.'
                  : selectionState.preparationErrorCode === 'PREVIEW_FINGERPRINT_MISMATCH'
                    ? 'Project file state has changed. Please re-check the files.'
                    : 'The selection could not be prepared as an import intent. Please check acknowledgements and try again.'
              }
            />
          )}

          {/* Step: Prepared Intent Banner */}
          {selectionState.preparedIntent && (
            <div className="p-4 rounded-lg bg-success/10 border border-success/30 flex flex-col gap-3 text-xs">
              <div className="flex items-center gap-2 text-success font-semibold text-sm">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <span>Import prepared successfully</span>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                The selected project details are verified and ready to be saved as draft records in the test environment.
              </p>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-2.5 rounded bg-background border border-border text-[11px]">
                <div>
                  <span className="text-muted-foreground block">Projects to save:</span>
                  <strong className="text-foreground">{selectionState.preparedIntent.selectedPackagePaths.length}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Selected files:</span>
                  <strong className="text-foreground">{selectionState.preparedIntent.fileCount}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Total size:</span>
                  <strong className="text-foreground">{formatMB(selectionState.preparedIntent.declaredTotalBytes)} MB</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Environment:</span>
                  <strong className="text-foreground">Test / Staging</strong>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
                <span className="text-[11px] text-muted-foreground">
                  Saving project details creates draft records. Media files are imported in the next step.
                </span>

                <Button
                  type="button"
                  size="sm"
                  onClick={handleStageMetadata}
                  disabled={isStaging || selectionState.isPreparing || isCompletingMedia}
                  className="font-semibold shrink-0"
                >
                  <Layers className="h-4 w-4 mr-1.5" aria-hidden="true" />
                  {isStaging ? 'Importing project details…' : 'Import project details'}
                </Button>
              </div>
            </div>
          )}

          {/* Staging Failure Feedback */}
          {stagingError && (
            <Alert
              variant="destructive"
              title="Project Details Import Failed"
              description={stagingError}
            />
          )}

          {/* Step: Metadata Staged Success & Media Action Card */}
          {stagedResult && (
            <div className="p-4 rounded-lg bg-information/10 border border-information/30 flex flex-col gap-4 text-xs">
              <div className="flex items-center gap-2 text-information font-semibold text-sm">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <span>
                  {stagedResult.result === 'already_staged'
                    ? 'Project details already saved (Idempotent)'
                    : 'Project details imported successfully'}
                </span>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {stagedResult.projectCount} project draft(s) have been created in the test environment. Complete the import by uploading media files below.
              </p>

              {/* Media Completion Action */}
              {!mediaCompleteResult && (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-background border border-border">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-semibold text-foreground">
                      Next step: Import media files
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      Uploads poster, PDF, and snapshot images to private draft storage. Nothing is published publicly.
                    </span>
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    onClick={handleCompleteMedia}
                    disabled={isCompletingMedia}
                    className="font-semibold shrink-0"
                  >
                    <Upload className="h-4 w-4 mr-1.5" aria-hidden="true" />
                    {isCompletingMedia ? 'Importing media…' : 'Import media & complete'}
                  </Button>
                </div>
              )}

              {mediaCompleteError && (
                <Alert
                  variant="destructive"
                  title="Media Import Failed"
                  description={`${mediaCompleteError} You can safely retry without losing saved project details.`}
                />
              )}
            </div>
          )}

          {/* Step: Import Completed Success Card */}
          {mediaCompleteResult && (
            <div className="p-5 rounded-lg bg-success/10 border border-success/30 flex flex-col gap-4 text-xs">
              <div className="flex items-center gap-2 text-success font-bold text-base">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                <span>
                  {mediaCompleteResult.result === 'already_completed'
                    ? 'Import already completed'
                    : 'Import completed successfully!'}
                </span>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                All project details and {mediaCompleteResult.mediaAssetCount} media files were imported into private draft storage. Projects remain in draft status for review.
              </p>

              <div className="flex items-center gap-3 pt-1">
                <Button asChild className="font-semibold">
                  <Link href={`/admin/imports/${mediaCompleteResult.batchId}`}>
                    Open import details
                    <ArrowRight className="h-4 w-4 ml-1.5" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
