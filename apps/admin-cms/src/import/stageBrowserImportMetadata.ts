import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { AuthenticatedAdminContext } from '../auth/authTypes';
import { BrowserImportCommitIntent } from './browserImportCommitIntentContract';
import {
  BrowserImportMetadataStageErrorCode,
  BrowserImportMetadataStageResponse,
  computeCanonicalIntentHash,
} from './browserImportMetadataStageContract';
import { BrowserImportServerAnalysis } from './parseBrowserImportPreview';

export async function stageBrowserImportMetadata(params: {
  authContext: AuthenticatedAdminContext;
  serverAnalysis: BrowserImportServerAnalysis;
  intent: BrowserImportCommitIntent;
}): Promise<BrowserImportMetadataStageResponse> {
  const { authContext, serverAnalysis, intent } = params;

  const intentHash = computeCanonicalIntentHash(intent);

  const selectedPathsSet = new Set(intent.selectedPackagePaths);
  const selectedPackages = serverAnalysis.packages.filter((pkg) =>
    selectedPathsSet.has(pkg.packagePath)
  );

  if (selectedPackages.length === 0) {
    return {
      success: false,
      code: 'INVALID_SELECTION',
      error: 'At least one package must be selected.',
    };
  }

  // Format packages payload for RPC
  const payloadPackages = selectedPackages.map((pkg) => {
    const disciplineList = pkg.manifest.discipline
      ? pkg.manifest.discipline.split(',').map((d) => d.trim()).filter((d) => d !== '')
      : [];
    const categoryList = pkg.manifest.industry
      ? pkg.manifest.industry.split(',').map((c) => c.trim()).filter((c) => c !== '')
      : [];

    return {
      packagePath: pkg.packagePath,
      publicId: pkg.proposedPublicId,
      title: pkg.manifest.title || pkg.proposedPublicId,
      summary: pkg.manifest.summary || '',
      background: pkg.manifest.background || '',
      solution: pkg.manifest.solution || '',
      year: Number(pkg.manifest.year) || 2026,
      program: pkg.manifest.program || pkg.manifest.studyProgram || '',
      studyProgram: pkg.manifest.studyProgram || pkg.manifest.program || '',
      industryPartner: pkg.manifest.industryPartner || '',
      academicSupervisor: pkg.manifest.academicSupervisor || '',
      groupName: pkg.manifest.groupName || '',
      teamMembers: Array.isArray(pkg.manifest.teamMembers) ? pkg.manifest.teamMembers : [],
      posterText: pkg.manifest.posterText || null,
      accessibilityText: pkg.manifest.accessibilityText || null,
      layoutConfig: pkg.manifest.layoutConfig || {},
      packageValidation: {
        status: pkg.status,
        metadataSource: pkg.metadataSource,
        filePresence: pkg.filePresence,
      },
      validationWarnings: pkg.warnings.map((w) => w.code),
      disciplines: disciplineList,
      industryCategories: categoryList,
      validationFlags: [
        ...pkg.warnings.map((w) => ({
          severity: 'warning',
          ruleCode: w.code,
          message: w.message,
          fieldName: w.fieldName || null,
        })),
      ],
    };
  });

  const supabase = createSupabaseAdminClientCore();

  const { data, error } = await supabase.rpc('stage_browser_import_metadata', {
    p_intent_hash: intentHash,
    p_preview_fingerprint: intent.previewFingerprint,
    p_canonical_intent: intent,
    p_mode: serverAnalysis.preview.batch.mode,
    p_source_folder: intent.selectedRootName,
    p_imported_by_id: authContext.adminUserId,
    p_packages: payloadPackages,
  });

  if (error) {
    process.stdout.write(`[Browser Import Stage RPC Error] ${error.code || 'UNKNOWN'}\n`);
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The metadata staging operation could not be saved.',
    };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The metadata staging operation returned an invalid response.',
    };
  }

  const res = data as Record<string, unknown>;

  if (res.resultCode && res.resultCode !== 'SUCCESS') {
    const codeStr = String(res.resultCode);
    const mapCode = (c: string): BrowserImportMetadataStageErrorCode => {
      if (c === 'PROJECT_ALREADY_EXISTS') return 'PROJECT_ALREADY_EXISTS';
      if (c === 'LOOKUP_NOT_FOUND') return 'LOOKUP_NOT_FOUND';
      if (c === 'INVALID_INTENT') return 'INVALID_INTENT';
      if (c === 'INVALID_SELECTION') return 'INVALID_SELECTION';
      return 'PERSISTENCE_FAILED';
    };
    return {
      success: false,
      code: mapCode(codeStr),
      error: codeStr === 'PROJECT_ALREADY_EXISTS'
        ? 'One or more selected project public IDs already exist.'
        : codeStr === 'LOOKUP_NOT_FOUND'
          ? 'Required program, discipline, or industry category lookup could not be found.'
          : 'The metadata staging operation failed.',
    };
  }

  return {
    success: true,
    result: res.result === 'already_staged' ? 'already_staged' : 'created',
    batchId: String(res.batchId),
    projectCount: Number(res.projectCount),
    warningCount: Number(res.warningCount),
    batchStatus: 'metadata_staged',
  };
}
