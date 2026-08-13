'use client';

import React, { useState } from 'react';
import {
  CANONICAL_MATCHABLE_FIELDS,
  CANONICAL_COMPARABLE_FIELDS,
  AdminReferenceInspectionResult,
  AdminReferenceMappingConfig,
} from '../../import/adminReferenceReconciliation';

interface AdminReferenceDatasetSectionProps {
  onMappingConfigured: (data: {
    referenceFile: File;
    mappingConfig: AdminReferenceMappingConfig;
  } | null) => void;
  disabled?: boolean;
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    setInspectionResult(null);
    setInspectError(null);
    onMappingConfigured(null);
  };

  const handleInspect = async () => {
    if (!selectedFile) return;
    setIsInspecting(true);
    setInspectError(null);

    try {
      const formData = new FormData();
      formData.append('referenceFile', selectedFile);

      const res = await fetch('/api/imports/admin-reference/inspect', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        setInspectError(json.error || 'Failed to inspect reference workbook.');
        setInspectionResult(null);
        onMappingConfigured(null);
      } else {
        const result: AdminReferenceInspectionResult = json;
        setInspectionResult(result);
        if (result.worksheets.length > 0) {
          const firstSheet = result.worksheets[0];
          setSelectedWorksheet(firstSheet.name);
          // Set default reference columns if matching names exist
          const matchCol = firstSheet.headers.find((h) => /group/i.test(h)) || firstSheet.headers[0] || '';
          const titleCol = firstSheet.headers.find((h) => /title/i.test(h)) || firstSheet.headers[1] || '';
          const progCol = firstSheet.headers.find((h) => /program|degree/i.test(h)) || firstSheet.headers[2] || '';

          const defaultMatch = [{ canonicalField: 'groupName', referenceColumn: matchCol }];
          const defaultComp = [
            { canonicalField: 'title', referenceColumn: titleCol },
            { canonicalField: 'program', referenceColumn: progCol },
          ].filter((c) => c.referenceColumn !== '');

          setMatchMappings(defaultMatch);
          setComparisonMappings(defaultComp);

          emitMappingIfValid(selectedFile, firstSheet.name, defaultMatch, defaultComp);
        }
      }
    } catch {
      setInspectError('Network error while inspecting reference workbook.');
      onMappingConfigured(null);
    } finally {
      setIsInspecting(false);
    }
  };

  const currentWorksheetHeaders =
    inspectionResult?.worksheets.find((w) => w.name === selectedWorksheet)?.headers || [];

  const emitMappingIfValid = (
    file: File | null,
    sheet: string,
    match: Array<{ canonicalField: string; referenceColumn: string }>,
    comp: Array<{ canonicalField: string; referenceColumn: string }>
  ) => {
    if (
      file &&
      sheet &&
      match.length > 0 &&
      match.every((m) => m.canonicalField && m.referenceColumn) &&
      comp.length > 0 &&
      comp.every((c) => c.canonicalField && c.referenceColumn)
    ) {
      onMappingConfigured({
        referenceFile: file,
        mappingConfig: {
          worksheet: sheet,
          matchMappings: match,
          comparisonMappings: comp,
          reconciliationContractVersion: 'admin-reference-reconciliation-v1',
        },
      });
    } else {
      onMappingConfigured(null);
    }
  };

  const handleWorksheetChange = (sheetName: string) => {
    setSelectedWorksheet(sheetName);
    emitMappingIfValid(selectedFile, sheetName, matchMappings, comparisonMappings);
  };

  const handleAddMatchMapping = () => {
    if (matchMappings.length >= 3) return;
    const availableCanonical = CANONICAL_MATCHABLE_FIELDS.find(
      (f) => !matchMappings.some((m) => m.canonicalField === f)
    ) || 'year';
    const next = [...matchMappings, { canonicalField: availableCanonical, referenceColumn: currentWorksheetHeaders[0] || '' }];
    setMatchMappings(next);
    emitMappingIfValid(selectedFile, selectedWorksheet, next, comparisonMappings);
  };

  const handleRemoveMatchMapping = (index: number) => {
    if (matchMappings.length <= 1) return;
    const next = matchMappings.filter((_, i) => i !== index);
    setMatchMappings(next);
    emitMappingIfValid(selectedFile, selectedWorksheet, next, comparisonMappings);
  };

  const handleMatchChange = (index: number, key: 'canonicalField' | 'referenceColumn', val: string) => {
    const next = [...matchMappings];
    next[index] = { ...next[index], [key]: val };
    setMatchMappings(next);
    emitMappingIfValid(selectedFile, selectedWorksheet, next, comparisonMappings);
  };

  const handleAddCompMapping = () => {
    if (comparisonMappings.length >= 20) return;
    const availableCanonical = CANONICAL_COMPARABLE_FIELDS.find(
      (f) => !comparisonMappings.some((m) => m.canonicalField === f)
    ) || 'year';
    const next = [...comparisonMappings, { canonicalField: availableCanonical, referenceColumn: currentWorksheetHeaders[0] || '' }];
    setComparisonMappings(next);
    emitMappingIfValid(selectedFile, selectedWorksheet, matchMappings, next);
  };

  const handleRemoveCompMapping = (index: number) => {
    if (comparisonMappings.length <= 1) return;
    const next = comparisonMappings.filter((_, i) => i !== index);
    setComparisonMappings(next);
    emitMappingIfValid(selectedFile, selectedWorksheet, matchMappings, next);
  };

  const handleCompChange = (index: number, key: 'canonicalField' | 'referenceColumn', val: string) => {
    const next = [...comparisonMappings];
    next[index] = { ...next[index], [key]: val };
    setComparisonMappings(next);
    emitMappingIfValid(selectedFile, selectedWorksheet, matchMappings, next);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Admin Reference Dataset Cross-Check (Optional)
          </h3>
          <p className="text-xs text-slate-500">
            Cross-check submitted project packages against an official staff reference spreadsheet.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="file"
          accept=".xlsx"
          disabled={disabled || isInspecting}
          onChange={handleFileChange}
          className="text-xs text-slate-600 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-slate-200 file:text-slate-700 hover:file:bg-slate-300"
        />
        {selectedFile && !inspectionResult && (
          <button
            type="button"
            onClick={handleInspect}
            disabled={disabled || isInspecting}
            className="px-3 py-1 bg-slate-800 text-white text-xs font-medium rounded hover:bg-slate-700 disabled:opacity-50"
          >
            {isInspecting ? 'Inspecting...' : 'Inspect Reference Workbook'}
          </button>
        )}
      </div>

      {inspectError && (
        <div className="p-2 text-xs text-red-600 bg-red-50 rounded border border-red-200">
          {inspectError}
        </div>
      )}

      {inspectionResult && (
        <div className="space-y-3 pt-2 border-t border-slate-200">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>
              Fingerprint: <code className="font-mono">{inspectionResult.referenceWorkbookFingerprint.slice(0, 12)}...</code>
            </span>
            <div className="flex items-center gap-2">
              <label className="font-medium text-slate-700">Worksheet:</label>
              <select
                value={selectedWorksheet}
                onChange={(e) => handleWorksheetChange(e.target.value)}
                className="text-xs border rounded px-2 py-1 bg-white"
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
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                1. Match Key Columns (1–3 composite fields):
              </span>
              {matchMappings.length < 3 && (
                <button
                  type="button"
                  onClick={handleAddMatchMapping}
                  className="text-xs text-blue-600 hover:underline font-medium"
                >
                  + Add Match Field
                </button>
              )}
            </div>
            {matchMappings.map((m, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <select
                  value={m.canonicalField}
                  onChange={(e) => handleMatchChange(idx, 'canonicalField', e.target.value)}
                  className="text-xs border rounded px-2 py-1 bg-white flex-1"
                >
                  {CANONICAL_MATCHABLE_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-slate-400">=</span>
                <select
                  value={m.referenceColumn}
                  onChange={(e) => handleMatchChange(idx, 'referenceColumn', e.target.value)}
                  className="text-xs border rounded px-2 py-1 bg-white flex-1"
                >
                  {currentWorksheetHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                {matchMappings.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveMatchMapping(idx)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Comparison Mappings */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                2. Comparison Fields to Cross-Check:
              </span>
              {comparisonMappings.length < 20 && (
                <button
                  type="button"
                  onClick={handleAddCompMapping}
                  className="text-xs text-blue-600 hover:underline font-medium"
                >
                  + Add Comparison Field
                </button>
              )}
            </div>
            {comparisonMappings.map((c, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <select
                  value={c.canonicalField}
                  onChange={(e) => handleCompChange(idx, 'canonicalField', e.target.value)}
                  className="text-xs border rounded px-2 py-1 bg-white flex-1"
                >
                  {CANONICAL_COMPARABLE_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-slate-400">=</span>
                <select
                  value={c.referenceColumn}
                  onChange={(e) => handleCompChange(idx, 'referenceColumn', e.target.value)}
                  className="text-xs border rounded px-2 py-1 bg-white flex-1"
                >
                  {currentWorksheetHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                {comparisonMappings.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveCompMapping(idx)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
