'use client';

import React, { useState } from 'react';
import {
  FileSpreadsheet,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Search,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  CANONICAL_MATCHABLE_FIELDS,
  CANONICAL_COMPARABLE_FIELDS,
  AdminReferenceInspectionResult,
  AdminReferenceMappingConfig,
} from '../../import/adminReferenceSharedContract';
import {
  deriveDefaultReferenceMappings,
  referenceMappingSetsEqual,
  HeaderMatchResult,
  ReferenceMappingSet,
} from '../../import/adminReferenceAutoMatcher';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Alert } from '../ui/alert';
import { Badge } from '../ui/badge';

interface AdminReferenceDatasetSectionProps {
  onMappingConfigured: (data: {
    referenceFile: File;
    mappingConfig: AdminReferenceMappingConfig;
  } | null) => void;
  disabled?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  publicId: 'Project ID',
  title: 'Project title',
  groupName: 'Group name',
  year: 'Academic year',
  program: 'Program',
  studyProgram: 'Study program',
  academicSupervisor: 'Academic supervisor',
  industryPartner: 'Industry partner',
  participantContactEmail: 'Participant contact email',
  teamMembers: 'Team members',
};

function formatFieldLabel(field: string): string {
  return FIELD_LABELS[field] || field;
}

export function AdminReferenceDatasetSection({
  onMappingConfigured,
  disabled = false,
}: AdminReferenceDatasetSectionProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectionResult, setInspectionResult] = useState<AdminReferenceInspectionResult | null>(null);
  const [autoMatchResult, setAutoMatchResult] = useState<HeaderMatchResult | null>(null);
  // Snapshot of the mappings the deterministic matcher proposed, kept separately from the mappings
  // currently on screen so a manual edit can never keep being presented as an automatic result.
  const [automaticSuggestion, setAutomaticSuggestion] = useState<ReferenceMappingSet | null>(null);
  const [isAutomaticComplete, setIsAutomaticComplete] = useState(false);
  const [isManualExpanded, setIsManualExpanded] = useState(false);

  const [selectedWorksheet, setSelectedWorksheet] = useState<string>('');
  const [matchMappings, setMatchMappings] = useState<Array<{ canonicalField: string; referenceColumn: string }>>([
    { canonicalField: 'groupName', referenceColumn: '' },
  ]);
  const [comparisonMappings, setComparisonMappings] = useState<Array<{ canonicalField: string; referenceColumn: string }>>([
    { canonicalField: 'title', referenceColumn: '' },
    { canonicalField: 'program', referenceColumn: '' },
  ]);

  const [isConfirmed, setIsConfirmed] = useState(false);

  const unconfirm = () => {
    setIsConfirmed(false);
    onMappingConfigured(null);
  };

  /** Re-derives the automatic suggestion for a worksheet and adopts it as the current mapping. */
  const applyAutomaticDerivation = (headers: string[]) => {
    const derivation = deriveDefaultReferenceMappings(headers);
    setAutoMatchResult(derivation.matchResult);
    setAutomaticSuggestion({
      matchMappings: derivation.matchMappings,
      comparisonMappings: derivation.comparisonMappings,
    });
    setIsAutomaticComplete(derivation.isAllRequiredMatched);
    setMatchMappings(derivation.matchMappings);
    setComparisonMappings(derivation.comparisonMappings);
    setIsManualExpanded(!derivation.isAllRequiredMatched);
  };

  /** Clears every trace of a previous workbook's matching identity. */
  const clearMappingIdentity = () => {
    setAutoMatchResult(null);
    setAutomaticSuggestion(null);
    setIsAutomaticComplete(false);
    setIsManualExpanded(false);
    setMatchMappings([{ canonicalField: 'groupName', referenceColumn: '' }]);
    setComparisonMappings([
      { canonicalField: 'title', referenceColumn: '' },
      { canonicalField: 'program', referenceColumn: '' },
    ]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    setInspectionResult(null);
    setInspectError(null);
    setSelectedWorksheet('');
    clearMappingIdentity();
    unconfirm();
  };

  const handleInspect = async () => {
    if (!selectedFile) return;
    setIsInspecting(true);
    setInspectError(null);
    unconfirm();

    try {
      const formData = new FormData();
      formData.append('referenceFile', selectedFile);

      const res = await fetch('/api/imports/admin-reference/inspect', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setInspectError('The reference spreadsheet could not be checked. Check the file and try again.');
        setInspectionResult(null);
        clearMappingIdentity();
      } else {
        const result: AdminReferenceInspectionResult = json;
        setInspectionResult(result);
        if (result.worksheets.length > 0) {
          const firstSheet = result.worksheets[0];
          setSelectedWorksheet(firstSheet.name);
          applyAutomaticDerivation(firstSheet.headers);
        }
      }
    } catch {
      setInspectError('The reference spreadsheet could not be checked. Check the network connection and try again.');
    } finally {
      setIsInspecting(false);
    }
  };

  const currentWorksheetHeaders =
    inspectionResult?.worksheets.find((w) => w.name === selectedWorksheet)?.headers || [];

  const handleWorksheetChange = (sheetName: string) => {
    setSelectedWorksheet(sheetName);
    unconfirm();

    const targetSheet = inspectionResult?.worksheets.find((w) => w.name === sheetName);
    applyAutomaticDerivation(targetSheet?.headers || []);
  };

  const handleAddMatchMapping = () => {
    if (matchMappings.length >= 3) return;
    const availableCanonical = CANONICAL_MATCHABLE_FIELDS.find(
      (f) => !matchMappings.some((m) => m.canonicalField === f)
    ) || 'year';
    setMatchMappings((prev) => [
      ...prev,
      { canonicalField: availableCanonical, referenceColumn: currentWorksheetHeaders[0] || '' },
    ]);
    unconfirm();
  };

  const handleRemoveMatchMapping = (index: number) => {
    if (matchMappings.length <= 1) return;
    setMatchMappings((prev) => prev.filter((_, i) => i !== index));
    unconfirm();
  };

  const handleMatchChange = (index: number, key: 'canonicalField' | 'referenceColumn', val: string) => {
    setMatchMappings((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [key]: val };
      return next;
    });
    unconfirm();
  };

  const handleAddCompMapping = () => {
    if (comparisonMappings.length >= 20) return;
    const availableCanonical = CANONICAL_COMPARABLE_FIELDS.find(
      (f) => !comparisonMappings.some((m) => m.canonicalField === f)
    ) || 'year';
    setComparisonMappings((prev) => [
      ...prev,
      { canonicalField: availableCanonical, referenceColumn: currentWorksheetHeaders[0] || '' },
    ]);
    unconfirm();
  };

  const handleRemoveCompMapping = (index: number) => {
    if (comparisonMappings.length <= 1) return;
    setComparisonMappings((prev) => prev.filter((_, i) => i !== index));
    unconfirm();
  };

  const handleCompChange = (index: number, key: 'canonicalField' | 'referenceColumn', val: string) => {
    setComparisonMappings((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [key]: val };
      return next;
    });
    unconfirm();
  };

  const isConfigValid =
    Boolean(selectedFile) &&
    Boolean(selectedWorksheet) &&
    matchMappings.length > 0 &&
    matchMappings.every((m) => m.canonicalField && m.referenceColumn) &&
    comparisonMappings.length > 0 &&
    comparisonMappings.every((c) => c.canonicalField && c.referenceColumn);

  const handleConfirmMapping = () => {
    if (isConfigValid && selectedFile && selectedWorksheet) {
      setIsConfirmed(true);
      onMappingConfigured({
        referenceFile: selectedFile,
        mappingConfig: {
          worksheet: selectedWorksheet,
          matchMappings,
          comparisonMappings,
          reconciliationContractVersion: 'admin-reference-reconciliation-v1',
        },
      });
    }
  };

  const isControlDisabled = disabled || isInspecting;

  // A configuration counts as automatic only while it is still exactly what the matcher proposed.
  // Any manual edit makes this false, which withdraws both the automatic claim and the
  // "Use these matches" action. Restoring the automatic mapping by hand makes it true again.
  const isPristineAutomatic =
    automaticSuggestion !== null &&
    referenceMappingSetsEqual({ matchMappings, comparisonMappings }, automaticSuggestion);
  const showAutomaticBanner = isAutomaticComplete && isPristineAutomatic;
  const showUnresolvedNotice =
    automaticSuggestion !== null && !isAutomaticComplete && isPristineAutomatic;
  const isManuallyEdited = automaticSuggestion !== null && !isPristineAutomatic;
  const showManualSection = isManualExpanded || !showAutomaticBanner;

  return (
    <Card className="border-border-structural">
      <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
        <div className="flex items-center gap-2 flex-wrap">
          <FileSpreadsheet className="h-4 w-4 text-primary" aria-hidden="true" />
          <CardTitle className="text-sm font-semibold text-foreground">
            School reference spreadsheet
          </CardTitle>
          <Badge variant="neutral">Required</Badge>
        </div>
        <CardDescription className="text-xs text-muted-foreground">
          Use the School&apos;s reference spreadsheet to match and cross-check the projects you are importing. A confirmed column match is required before a selection can be confirmed or saved.
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 sm:p-6 flex flex-col gap-4 text-xs sm:text-sm">
        {/* File Picker & Inspect Action */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0">
            <label htmlFor="admin-reference-file-input" className="sr-only">
              Choose School reference spreadsheet
            </label>
            <input
              id="admin-reference-file-input"
              type="file"
              accept=".xlsx"
              disabled={isControlDisabled}
              onChange={handleFileChange}
              className="text-xs text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-muted file:text-foreground hover:file:bg-muted/80 disabled:opacity-50 cursor-pointer w-full"
            />
          </div>

          {selectedFile && !inspectionResult && (
            <Button
              type="button"
              size="sm"
              onClick={handleInspect}
              disabled={isControlDisabled}
              className="shrink-0 font-medium"
            >
              <Search className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              {isInspecting ? 'Checking spreadsheet…' : 'Check spreadsheet'}
            </Button>
          )}
        </div>

        {inspectError && (
          <Alert
            variant="destructive"
            title="Check Failed"
            description={inspectError}
          />
        )}

        {/* Inspection & Column Matching Controls */}
        {inspectionResult && (
          <div className="flex flex-col gap-4 pt-3 border-t border-border">
            {/* Worksheet Selection Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-md bg-muted/40 border border-border">
              <span className="text-xs text-muted-foreground font-medium">
                Spreadsheet checked: {inspectionResult.worksheets.length} worksheet(s)
              </span>

              <div className="flex items-center gap-2">
                <label htmlFor="worksheet-selector" className="text-xs font-semibold text-foreground shrink-0">
                  Worksheet:
                </label>
                <select
                  id="worksheet-selector"
                  value={selectedWorksheet}
                  disabled={isControlDisabled}
                  onChange={(e) => handleWorksheetChange(e.target.value)}
                  className="h-10 text-sm border border-input rounded-md px-3 bg-background text-foreground focus:ring-2 focus:ring-ring disabled:opacity-50"
                >
                  {inspectionResult.worksheets.map((ws) => (
                    <option key={ws.name} value={ws.name}>
                      {ws.name} ({ws.rowCount} rows)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Confident Auto-Match Presentation */}
            {showAutomaticBanner && (
              <div className="rounded-lg border border-success/30 bg-success/5 p-3.5 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-foreground font-semibold text-xs sm:text-sm">
                  <CheckCircle2 className="h-4 w-4 text-success shrink-0" aria-hidden="true" />
                  <span>Columns recognised automatically</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                  <div className="flex flex-col p-2.5 rounded-md bg-background border border-border">
                    <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Group name</span>
                    <span className="font-semibold text-foreground truncate mt-0.5" title={matchMappings[0]?.referenceColumn}>
                      → {matchMappings[0]?.referenceColumn}
                    </span>
                  </div>

                  <div className="flex flex-col p-2.5 rounded-md bg-background border border-border">
                    <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Project title</span>
                    <span className="font-semibold text-foreground truncate mt-0.5" title={comparisonMappings[0]?.referenceColumn}>
                      → {comparisonMappings[0]?.referenceColumn}
                    </span>
                  </div>

                  <div className="flex flex-col p-2.5 rounded-md bg-background border border-border">
                    <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">Program</span>
                    <span className="font-semibold text-foreground truncate mt-0.5" title={comparisonMappings[1]?.referenceColumn}>
                      → {comparisonMappings[1]?.referenceColumn}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={isConfirmed ? 'outline' : 'default'}
                    onClick={handleConfirmMapping}
                    disabled={isControlDisabled || isConfirmed || !isConfigValid}
                    className="font-semibold"
                  >
                    {isConfirmed ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-success" aria-hidden="true" />
                        Matches confirmed
                      </>
                    ) : (
                      'Use these matches'
                    )}
                  </Button>

                  <button
                    type="button"
                    onClick={() => setIsManualExpanded((prev) => !prev)}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1.5 py-1 min-h-[32px]"
                    aria-expanded={isManualExpanded}
                  >
                    <span>{isManualExpanded ? 'Hide column matching' : 'Change column matching'}</span>
                    {isManualExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Incomplete or Ambiguous Auto-Match Notice */}
            {showUnresolvedNotice && autoMatchResult && (
              <div className="p-3.5 rounded-lg bg-warning/10 border border-warning/30 text-xs flex flex-col gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-warning-strong">
                  <AlertCircle className="h-4 w-4 text-warning shrink-0" aria-hidden="true" />
                  <span>We could not confidently match all required columns. Review the column matching below.</span>
                </div>
                {Object.entries(autoMatchResult.ambiguous).map(([field, cols]) => (
                  <p key={field} className="text-foreground text-xs pl-5.5">
                    More than one spreadsheet column could be <strong>{formatFieldLabel(field)}</strong>: {cols.join(', ')}.
                  </p>
                ))}
              </div>
            )}

            {/* Progressive Disclosure Manual Matching Area */}
            {showManualSection && (
              <div className="flex flex-col gap-4 pt-2 border-t border-border">
                <div className="flex flex-col gap-1">
                  <p className="text-xs sm:text-sm font-semibold text-foreground">
                    {isManuallyEdited ? 'Review your column matching' : 'Column matching'}
                  </p>
                  {isManuallyEdited && (
                    <p className="text-xs text-muted-foreground">
                      You changed the column matching, so it is no longer the automatic suggestion. Review it and confirm it below.
                    </p>
                  )}
                </div>
                {/* Composite Match Mappings */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground">
                      1. Match projects using:
                    </span>
                    {matchMappings.length < 3 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleAddMatchMapping}
                        disabled={isControlDisabled}
                        className="h-7 text-xs text-primary px-2"
                      >
                        <Plus className="h-3 w-3 mr-1" aria-hidden="true" />
                        Add match field
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground -mt-1">
                    Select the project field and corresponding column in the reference spreadsheet used to uniquely identify each project.
                  </p>

                  <div className="flex flex-col gap-2.5">
                    {matchMappings.map((m, idx) => (
                      <div
                        key={idx}
                        className="flex flex-col sm:flex-row sm:items-center gap-2 p-2.5 sm:p-0 rounded-md border border-border sm:border-0 bg-muted/20 sm:bg-transparent"
                      >
                        <div className="flex-1 w-full min-w-0">
                          <label htmlFor={`match-field-${idx}`} className="block sm:sr-only text-[11px] text-muted-foreground font-medium mb-1">
                            Project field
                          </label>
                          <select
                            id={`match-field-${idx}`}
                            value={m.canonicalField}
                            disabled={isControlDisabled}
                            onChange={(e) => handleMatchChange(idx, 'canonicalField', e.target.value)}
                            aria-label={`Match field ${idx + 1} project field`}
                            className="h-10 text-sm border border-input rounded-md px-3 bg-background text-foreground w-full truncate focus:ring-2 focus:ring-ring disabled:opacity-50"
                          >
                            {CANONICAL_MATCHABLE_FIELDS.map((f) => (
                              <option key={f} value={f}>
                                {formatFieldLabel(f)}
                              </option>
                            ))}
                          </select>
                        </div>

                        <ArrowRight className="hidden sm:block h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />

                        <div className="flex-1 w-full min-w-0">
                          <label htmlFor={`match-col-${idx}`} className="block sm:sr-only text-[11px] text-muted-foreground font-medium mb-1">
                            Spreadsheet column
                          </label>
                          <select
                            id={`match-col-${idx}`}
                            value={m.referenceColumn}
                            disabled={isControlDisabled}
                            onChange={(e) => handleMatchChange(idx, 'referenceColumn', e.target.value)}
                            aria-label={`Match field ${idx + 1} spreadsheet column`}
                            className="h-10 text-sm border border-input rounded-md px-3 bg-background text-foreground w-full truncate focus:ring-2 focus:ring-ring disabled:opacity-50"
                          >
                            <option value="" disabled>Select column…</option>
                            {currentWorksheetHeaders.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </div>

                        {matchMappings.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveMatchMapping(idx)}
                            disabled={isControlDisabled}
                            aria-label={`Remove match field ${idx + 1}`}
                            className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10 self-end sm:self-center"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Comparison Mappings */}
                <div className="flex flex-col gap-2 pt-2 border-t border-border">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground">
                      2. Compare these details:
                    </span>
                    {comparisonMappings.length < 20 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleAddCompMapping}
                        disabled={isControlDisabled}
                        className="h-7 text-xs text-primary px-2"
                      >
                        <Plus className="h-3 w-3 mr-1" aria-hidden="true" />
                        Add comparison field
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground -mt-1">
                    Select project fields to cross-check against the reference spreadsheet to detect discrepancies before saving.
                  </p>

                  <div className="flex flex-col gap-2.5">
                    {comparisonMappings.map((c, idx) => (
                      <div
                        key={idx}
                        className="flex flex-col sm:flex-row sm:items-center gap-2 p-2.5 sm:p-0 rounded-md border border-border sm:border-0 bg-muted/20 sm:bg-transparent"
                      >
                        <div className="flex-1 w-full min-w-0">
                          <label htmlFor={`compare-field-${idx}`} className="block sm:sr-only text-[11px] text-muted-foreground font-medium mb-1">
                            Project field
                          </label>
                          <select
                            value={c.canonicalField}
                            id={`compare-field-${idx}`}
                            disabled={isControlDisabled}
                            onChange={(e) => handleCompChange(idx, 'canonicalField', e.target.value)}
                            aria-label={`Comparison field ${idx + 1} project field`}
                            className="h-10 text-sm border border-input rounded-md px-3 bg-background text-foreground w-full truncate focus:ring-2 focus:ring-ring disabled:opacity-50"
                          >
                            {CANONICAL_COMPARABLE_FIELDS.map((f) => (
                              <option key={f} value={f}>
                                {formatFieldLabel(f)}
                              </option>
                            ))}
                          </select>
                        </div>

                        <ArrowRight className="hidden sm:block h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />

                        <div className="flex-1 w-full min-w-0">
                          <label htmlFor={`compare-col-${idx}`} className="block sm:sr-only text-[11px] text-muted-foreground font-medium mb-1">
                            Spreadsheet column
                          </label>
                          <select
                            value={c.referenceColumn}
                            id={`compare-col-${idx}`}
                            disabled={isControlDisabled}
                            onChange={(e) => handleCompChange(idx, 'referenceColumn', e.target.value)}
                            aria-label={`Comparison field ${idx + 1} spreadsheet column`}
                            className="h-10 text-sm border border-input rounded-md px-3 bg-background text-foreground w-full truncate focus:ring-2 focus:ring-ring disabled:opacity-50"
                          >
                            <option value="" disabled>Select column…</option>
                            {currentWorksheetHeaders.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </div>

                        {comparisonMappings.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveCompMapping(idx)}
                            disabled={isControlDisabled}
                            aria-label={`Remove comparison field ${idx + 1}`}
                            className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10 self-end sm:self-center"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Explicit Manual Confirmation Action */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-border">
                  <div className="text-xs">
                    {isConfirmed ? (
                      <span className="text-success font-semibold flex items-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                        Column matching confirmed
                      </span>
                    ) : (
                      <span className="text-warning font-medium flex items-center gap-1.5">
                        <AlertCircle className="h-4 w-4 text-warning" aria-hidden="true" />
                        Column matching not confirmed — confirm the matches before preparing projects for import.
                      </span>
                    )}
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    variant={isConfirmed ? 'outline' : 'default'}
                    onClick={handleConfirmMapping}
                    disabled={isControlDisabled || isConfirmed || !isConfigValid}
                    className="font-semibold shrink-0"
                  >
                    {isConfirmed ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-success" aria-hidden="true" />
                        Confirmed
                      </>
                    ) : (
                      'Confirm column matching'
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
