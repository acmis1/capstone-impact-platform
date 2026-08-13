import { z } from 'zod';
import { BROWSER_IMPORT_LIMITS } from './browserImportPreviewContract';
import type { BrowserImportPackagePreview, BrowserImportPreviewBatch } from './browserImportPreviewContract';

export const adminReferenceIntentSchema = z
  .object({
    workbookFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    worksheet: z.string().min(1).max(100),
    matchMappings: z
      .array(
        z.object({
          canonicalField: z.string().min(1).max(50),
          referenceColumn: z.string().min(1).max(100),
        }).strict()
      )
      .min(1)
      .max(3),
    comparisonMappings: z
      .array(
        z.object({
          canonicalField: z.string().min(1).max(50),
          referenceColumn: z.string().min(1).max(100),
        }).strict()
      )
      .min(1)
      .max(20),
    reconciliationContractVersion: z.literal('admin-reference-reconciliation-v1'),
  })
  .strict();

export type AdminReferenceIntent = z.infer<typeof adminReferenceIntentSchema>;

/**
 * Strict Zod Schema and TypeScript Contract for BrowserImportCommitIntent
 */
export const browserImportCommitIntentSchema = z
  .object({
    version: z.literal(1),
    previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    selectedRootName: z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_NAME),
    fileCount: z.number().int().nonnegative().finite().max(BROWSER_IMPORT_LIMITS.MAX_DESCRIPTORS),
    declaredTotalBytes: z.number().int().nonnegative().finite().max(BROWSER_IMPORT_LIMITS.MAX_MULTIPART_REQUEST_BYTES),
    selectedPackagePaths: z
      .array(z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_PATH))
      .min(1)
      .max(BROWSER_IMPORT_LIMITS.MAX_PACKAGES)
      .refine(
        (arr) => new Set(arr).size === arr.length,
        { message: 'Selected package paths must contain no duplicates.' }
      )
      .refine(
        (arr) => [...arr].sort((a, b) => a.localeCompare(b)).every((v, i) => v === arr[i]),
        { message: 'Selected package paths must be sorted deterministically.' }
      ),
    acknowledgedWarningPackagePaths: z
      .array(z.string().min(1).max(BROWSER_IMPORT_LIMITS.MAX_STRING_PATH))
      .max(BROWSER_IMPORT_LIMITS.MAX_PACKAGES)
      .refine(
        (arr) => new Set(arr).size === arr.length,
        { message: 'Acknowledged warning package paths must contain no duplicates.' }
      )
      .refine(
        (arr) => [...arr].sort((a, b) => a.localeCompare(b)).every((v, i) => v === arr[i]),
        { message: 'Acknowledged warning package paths must be sorted deterministically.' }
      ),
    adminReference: adminReferenceIntentSchema.optional(),
  })
  .strict();

export type BrowserImportCommitIntent = z.infer<typeof browserImportCommitIntentSchema>;

export type BrowserImportPreparationErrorCode =
  | 'EMPTY_SELECTION'
  | 'PREVIEW_FINGERPRINT_MISMATCH'
  | 'INVALID_SELECTION'
  | 'PREPARATION_ALREADY_PENDING'
  | 'UNEXPECTED_PREPARATION_FAILURE';

export interface BrowserImportSelectionState {
  previewFingerprint: string;
  selectedPackagePaths: string[];
  acknowledgedWarningPackagePaths: string[];
  isPreparing: boolean;
  preparedIntent: BrowserImportCommitIntent | null;
  preparationErrorCode: BrowserImportPreparationErrorCode | null;
}

/**
 * Creates the initial BrowserImportSelectionState from a validated preview batch.
 * Valid packages are selected by default. Warning packages are unselected. Invalid packages are unselectable.
 */
export function createInitialSelectionState(batch: BrowserImportPreviewBatch): BrowserImportSelectionState {
  const validSelected = batch.packages
    .filter((pkg) => pkg.status === 'valid')
    .map((pkg) => pkg.packagePath)
    .sort((a, b) => a.localeCompare(b));

  return {
    previewFingerprint: batch.previewFingerprint,
    selectedPackagePaths: validSelected,
    acknowledgedWarningPackagePaths: [],
    isPreparing: false,
    preparedIntent: null,
    preparationErrorCode: null,
  };
}

/**
 * Pure state transition functions for package selection.
 * All mutations return new state objects without mutating input state.
 */
export function toggleValidPackage(
  state: BrowserImportSelectionState,
  packagePath: string,
  packages: BrowserImportPackagePreview[]
): BrowserImportSelectionState {
  const pkg = packages.find((p) => p.packagePath === packagePath);
  if (!pkg || pkg.status !== 'valid') {
    return state;
  }

  const isSelected = state.selectedPackagePaths.includes(packagePath);
  const nextSelected = isSelected
    ? state.selectedPackagePaths.filter((p) => p !== packagePath)
    : [...state.selectedPackagePaths, packagePath].sort((a, b) => a.localeCompare(b));

  return {
    ...state,
    selectedPackagePaths: nextSelected,
    preparedIntent: null,
    preparationErrorCode: null,
  };
}

export function toggleWarningAcknowledgement(
  state: BrowserImportSelectionState,
  packagePath: string,
  packages: BrowserImportPackagePreview[]
): BrowserImportSelectionState {
  const pkg = packages.find((p) => p.packagePath === packagePath);
  if (!pkg || pkg.status !== 'warning') {
    return state;
  }

  const isAcked = state.acknowledgedWarningPackagePaths.includes(packagePath);
  const nextAcked = isAcked
    ? state.acknowledgedWarningPackagePaths.filter((p) => p !== packagePath)
    : [...state.acknowledgedWarningPackagePaths, packagePath].sort((a, b) => a.localeCompare(b));

  // Removing acknowledgement automatically deselects warning package if selected
  const nextSelected = isAcked
    ? state.selectedPackagePaths.filter((p) => p !== packagePath)
    : state.selectedPackagePaths;

  return {
    ...state,
    acknowledgedWarningPackagePaths: nextAcked,
    selectedPackagePaths: nextSelected,
    preparedIntent: null,
    preparationErrorCode: null,
  };
}

export function toggleWarningPackageSelection(
  state: BrowserImportSelectionState,
  packagePath: string,
  packages: BrowserImportPackagePreview[]
): BrowserImportSelectionState {
  const pkg = packages.find((p) => p.packagePath === packagePath);
  if (!pkg || pkg.status !== 'warning') {
    return state;
  }

  // Mandatory policy: must be acknowledged to select!
  if (!state.acknowledgedWarningPackagePaths.includes(packagePath)) {
    return state;
  }

  const isSelected = state.selectedPackagePaths.includes(packagePath);
  const nextSelected = isSelected
    ? state.selectedPackagePaths.filter((p) => p !== packagePath)
    : [...state.selectedPackagePaths, packagePath].sort((a, b) => a.localeCompare(b));

  return {
    ...state,
    selectedPackagePaths: nextSelected,
    preparedIntent: null,
    preparationErrorCode: null,
  };
}

export function setPreparing(state: BrowserImportSelectionState, isPreparing: boolean): BrowserImportSelectionState {
  if (state.isPreparing === isPreparing) return state;
  return {
    ...state,
    isPreparing,
  };
}

export function setPreparedSuccess(
  state: BrowserImportSelectionState,
  intent: BrowserImportCommitIntent
): BrowserImportSelectionState {
  return {
    ...state,
    isPreparing: false,
    preparedIntent: intent,
    preparationErrorCode: null,
  };
}

export function setPreparedFailure(
  state: BrowserImportSelectionState,
  errorCode: BrowserImportPreparationErrorCode
): BrowserImportSelectionState {
  return {
    ...state,
    isPreparing: false,
    preparedIntent: null,
    preparationErrorCode: errorCode,
  };
}

export function resetSelectionState(): BrowserImportSelectionState {
  return {
    previewFingerprint: '',
    selectedPackagePaths: [],
    acknowledgedWarningPackagePaths: [],
    isPreparing: false,
    preparedIntent: null,
    preparationErrorCode: null,
  };
}
