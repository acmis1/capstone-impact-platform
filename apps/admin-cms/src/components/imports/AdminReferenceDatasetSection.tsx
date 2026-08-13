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

      const json = await res.json();
      if (!res.ok || !json.success) {
        setInspectError(json.error || 'Failed to inspect reference workbook.');
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
      setInspectError('Network error while inspecting reference workbook.');
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
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Admin Reference Dataset Cross-Check (Required for Staging)
          </h3>
          <p className="text-xs text-slate-500">
            Cross-check submitted project packages against an official administrative reference spreadsheet.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="file"
          accept=".xlsx"
          disabled={isControlDisabled}
          onChange={handleFileChange}
          className="text-xs text-slate-600 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-slate-200 file:text-slate-700 hover:file:bg-slate-300 disabled:opacity-50"
        />
        {selectedFile && !inspectionResult && (
          <button
            type="button"
            onClick={handleInspect}
            disabled={isControlDisabled}
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
                disabled={isControlDisabled}
                onChange={(e) => handleWorksheetChange(e.target.value)}
                className="text-xs border rounded px-2 py-1 bg-white disabled:opacity-50"
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
                  disabled={isControlDisabled}
                  className="text-xs text-blue-600 hover:underline font-medium disabled:opacity-50"
                >
                  + Add Match Field
                </button>
              )}
            </div>
            {matchMappings.map((m, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <select
                  value={m.canonicalField}
                  disabled={isControlDisabled}
                  onChange={(e) => handleMatchChange(idx, 'canonicalField', e.target.value)}
                  className="text-xs border rounded px-2 py-1 bg-white flex-1 disabled:opacity-50"
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
                  disabled={isControlDisabled}
                  onChange={(e) => handleMatchChange(idx, 'referenceColumn', e.target.value)}
                  className="text-xs border rounded px-2 py-1 bg-white flex-1 disabled:opacity-50"
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
                    disabled={isControlDisabled}
                    className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
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
                  disabled={isControlDisabled}
                  className="text-xs text-blue-600 hover:underline font-medium disabled:opacity-50"
                >
                  + Add Comparison Field
                </button>
              )}
            </div>
            {comparisonMappings.map((c, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <select
                  value={c.canonicalField}
                  disabled={isControlDisabled}
                  onChange={(e) => handleCompChange(idx, 'canonicalField', e.target.value)}
                  className="text-xs border rounded px-2 py-1 bg-white flex-1 disabled:opacity-50"
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
                  disabled={isControlDisabled}
                  onChange={(e) => handleCompChange(idx, 'referenceColumn', e.target.value)}
                  className="text-xs border rounded px-2 py-1 bg-white flex-1 disabled:opacity-50"
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
                    disabled={isControlDisabled}
                    className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Explicit Confirmation Action */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-200">
            <div className="text-xs font-medium">
              {isConfirmed ? (
                <span className="text-emerald-700 font-semibold flex items-center gap-1">
                  ✓ Mapping Confirmed
                </span>
              ) : (
                <span className="text-amber-700 font-medium">
                  ⚠️ Mapping Unconfirmed (Staff confirmation required)
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={handleConfirmMapping}
              disabled={isControlDisabled || isConfirmed}
              className="px-3 py-1.5 bg-emerald-700 text-white text-xs font-bold rounded hover:bg-emerald-800 disabled:opacity-50"
            >
              {isConfirmed ? '✓ Confirmed' : 'Confirm Mapping'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
