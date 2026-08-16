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
} from 'lucide-react';
import {
  CANONICAL_MATCHABLE_FIELDS,
  CANONICAL_COMPARABLE_FIELDS,
  AdminReferenceInspectionResult,
  AdminReferenceMappingConfig,
} from '../../import/adminReferenceSharedContract';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Alert } from '../ui/alert';

interface AdminReferenceDatasetSectionProps {
  onMappingConfigured: (data: {
    referenceFile: File;
    mappingConfig: AdminReferenceMappingConfig;
  } | null) => void;
  disabled?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  groupName: 'Group name',
  title: 'Project title',
  program: 'Study program',
  discipline: 'Discipline',
  year: 'Academic year',
  publicId: 'Public ID',
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    setInspectionResult(null);
    setInspectError(null);
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
        setInspectError('The reference workbook could not be inspected. Check the file and try again.');
        setInspectionResult(null);
      } else {
        const result: AdminReferenceInspectionResult = json;
        setInspectionResult(result);
        if (result.worksheets.length > 0) {
          const firstSheet = result.worksheets[0];
          setSelectedWorksheet(firstSheet.name);
          const firstHeader = firstSheet.headers[0] || '';
          const secondHeader = firstSheet.headers[1] || firstHeader;
          const thirdHeader = firstSheet.headers[2] || secondHeader;

          setMatchMappings([{ canonicalField: 'groupName', referenceColumn: firstHeader }]);
          setComparisonMappings([
            { canonicalField: 'title', referenceColumn: secondHeader },
            { canonicalField: 'program', referenceColumn: thirdHeader },
          ].filter((c) => c.referenceColumn !== ''));
        }
      }
    } catch {
      setInspectError('The reference workbook could not be inspected. Check the network connection and try again.');
    } finally {
      setIsInspecting(false);
    }
  };

  const currentWorksheetHeaders =
    inspectionResult?.worksheets.find((w) => w.name === selectedWorksheet)?.headers || [];

  const handleWorksheetChange = (sheetName: string) => {
    setSelectedWorksheet(sheetName);
    unconfirm();
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

  const handleConfirmMapping = () => {
    if (
      selectedFile &&
      selectedWorksheet &&
      matchMappings.length > 0 &&
      matchMappings.every((m) => m.canonicalField && m.referenceColumn) &&
      comparisonMappings.length > 0 &&
      comparisonMappings.every((c) => c.canonicalField && c.referenceColumn)
    ) {
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

  return (
    <Card className="bg-card border-border shadow-xs">
      <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-primary" aria-hidden="true" />
          <CardTitle className="text-sm font-semibold text-foreground">
            Admin Reference file
          </CardTitle>
        </div>
        <CardDescription className="text-xs text-muted-foreground">
          Use the School&apos;s reference spreadsheet to match and cross-check the projects you are importing.
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 sm:p-6 flex flex-col gap-4 text-xs sm:text-sm">
        {/* File Picker & Inspect Action */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0">
            <label htmlFor="admin-reference-file-input" className="sr-only">
              Choose Admin Reference spreadsheet
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
              {isInspecting ? 'Inspecting…' : 'Inspect reference file'}
            </Button>
          )}
        </div>

        {inspectError && (
          <Alert
            variant="destructive"
            title="Inspection Failed"
            description={inspectError}
          />
        )}

        {/* Inspection & Column Mapping Controls */}
        {inspectionResult && (
          <div className="flex flex-col gap-4 pt-3 border-t border-border">
            {/* Worksheet Selection Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-md bg-muted/40 border border-border">
              <span className="text-xs text-muted-foreground font-medium">
                Reference file loaded: {inspectionResult.worksheets.length} worksheet(s)
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
                  className="text-xs border border-input rounded-md px-2.5 py-1 bg-background text-foreground focus:ring-1 focus:ring-ring disabled:opacity-50"
                >
                  {inspectionResult.worksheets.map((ws) => (
                    <option key={ws.name} value={ws.name}>
                      {ws.name} ({ws.rowCount} rows)
                    </option>
                  ))}
                </select>
              </div>
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
              <p className="text-[11px] text-muted-foreground -mt-1">
                Select the project field and corresponding column in the reference spreadsheet used to uniquely identify each project.
              </p>

              <div className="flex flex-col gap-2">
                {matchMappings.map((m, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={m.canonicalField}
                      disabled={isControlDisabled}
                      onChange={(e) => handleMatchChange(idx, 'canonicalField', e.target.value)}
                      aria-label={`Match field ${idx + 1} project property`}
                      className="text-xs border border-input rounded-md px-2.5 py-1.5 bg-background text-foreground flex-1 disabled:opacity-50"
                    >
                      {CANONICAL_MATCHABLE_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {formatFieldLabel(f)}
                        </option>
                      ))}
                    </select>

                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />

                    <select
                      value={m.referenceColumn}
                      disabled={isControlDisabled}
                      onChange={(e) => handleMatchChange(idx, 'referenceColumn', e.target.value)}
                      aria-label={`Match field ${idx + 1} reference column`}
                      className="text-xs border border-input rounded-md px-2.5 py-1.5 bg-background text-foreground flex-1 disabled:opacity-50"
                    >
                      {currentWorksheetHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>

                    {matchMappings.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveMatchMapping(idx)}
                        disabled={isControlDisabled}
                        aria-label={`Remove match field ${idx + 1}`}
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
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
              <p className="text-[11px] text-muted-foreground -mt-1">
                Select project fields to cross-check against the reference spreadsheet to detect discrepancies before saving.
              </p>

              <div className="flex flex-col gap-2">
                {comparisonMappings.map((c, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={c.canonicalField}
                      disabled={isControlDisabled}
                      onChange={(e) => handleCompChange(idx, 'canonicalField', e.target.value)}
                      aria-label={`Comparison field ${idx + 1} project property`}
                      className="text-xs border border-input rounded-md px-2.5 py-1.5 bg-background text-foreground flex-1 disabled:opacity-50"
                    >
                      {CANONICAL_COMPARABLE_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {formatFieldLabel(f)}
                        </option>
                      ))}
                    </select>

                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />

                    <select
                      value={c.referenceColumn}
                      disabled={isControlDisabled}
                      onChange={(e) => handleCompChange(idx, 'referenceColumn', e.target.value)}
                      aria-label={`Comparison field ${idx + 1} reference column`}
                      className="text-xs border border-input rounded-md px-2.5 py-1.5 bg-background text-foreground flex-1 disabled:opacity-50"
                    >
                      {currentWorksheetHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>

                    {comparisonMappings.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveCompMapping(idx)}
                        disabled={isControlDisabled}
                        aria-label={`Remove comparison field ${idx + 1}`}
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Explicit Confirmation Action */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-border">
              <div className="text-xs">
                {isConfirmed ? (
                  <span className="text-success font-semibold flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                    Mapping confirmed
                  </span>
                ) : (
                  <span className="text-warning font-medium flex items-center gap-1.5">
                    <AlertCircle className="h-4 w-4 text-warning" aria-hidden="true" />
                    Mapping not confirmed (Staff confirmation required before checking project files)
                  </span>
                )}
              </div>

              <Button
                type="button"
                size="sm"
                variant={isConfirmed ? 'outline' : 'default'}
                onClick={handleConfirmMapping}
                disabled={isControlDisabled || isConfirmed}
                className="font-semibold shrink-0"
              >
                {isConfirmed ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-success" aria-hidden="true" />
                    Confirmed
                  </>
                ) : (
                  'Confirm mapping'
                )}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
