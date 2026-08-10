import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { AuthenticatedAdminContext } from '../auth/authTypes';
import { BrowserImportCommitIntent } from './browserImportCommitIntentContract';
import {
  BrowserImportMetadataStageErrorCode,
  BrowserImportMetadataStageResponse,
  computeCanonicalIntentHash,
} from './browserImportMetadataStageContract';
import { BrowserImportServerAnalysis } from './parseBrowserImportPreview';
import { validateFolderDerivedPublicId } from './publicIdValidation';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function stageBrowserImportMetadata(params: {
  authContext: AuthenticatedAdminContext;
  serverAnalysis: BrowserImportServerAnalysis;
  intent: BrowserImportCommitIntent;
}): Promise<BrowserImportMetadataStageResponse> {
  const { authContext, serverAnalysis, intent } = params;

  const intentHash = computeCanonicalIntentHash(intent);

  const selectedPathsSet = new Set(intent.selectedPackagePaths);
  if (selectedPathsSet.size !== intent.selectedPackagePaths.length) {
    return {
      success: false,
      code: 'INVALID_SELECTION',
      error: 'Selected package paths must be unique.',
    };
  }

  const selectedPackages = serverAnalysis.packages.filter((pkg) =>
    selectedPathsSet.has(pkg.packagePath)
  );

  if (selectedPackages.length !== intent.selectedPackagePaths.length) {
    return {
      success: false,
      code: 'INVALID_SELECTION',
      error: 'All selected packages must exist in the analysis result.',
    };
  }

  if (selectedPackages.length === 0 || selectedPackages.length > 25) {
    return {
      success: false,
      code: 'INVALID_SELECTION',
      error: 'Selected package count must be between 1 and 25.',
    };
  }

  const publicIdsSeen = new Set<string>();
  for (const pkg of selectedPackages) {
    if (!pkg.manifest) {
      return {
        success: false,
        code: 'INVALID_SELECTION',
        error: 'Selected packages must have a valid authoritative manifest.',
      };
    }

    if (pkg.status !== 'valid' && pkg.status !== 'warning') {
      return {
        success: false,
        code: 'INVALID_SELECTION',
        error: 'Invalid packages cannot be staged.',
      };
    }

    if (pkg.status === 'warning' && !intent.acknowledgedWarningPackagePaths.includes(pkg.packagePath)) {
      return {
        success: false,
        code: 'INVALID_SELECTION',
        error: 'Warning packages must be explicitly acknowledged.',
      };
    }

    if (!pkg.packagePath || pkg.packagePath.length > 200) {
      return {
        success: false,
        code: 'INVALID_SELECTION',
        error: 'Package path is invalid or oversized.',
      };
    }

    const publicIdRes = validateFolderDerivedPublicId(pkg.proposedPublicId);
    if (!publicIdRes.valid) {
      return {
        success: false,
        code: 'INVALID_SELECTION',
        error: publicIdRes.message || 'Public ID is invalid.',
      };
    }

    if (publicIdsSeen.has(pkg.proposedPublicId)) {
      return {
        success: false,
        code: 'INVALID_SELECTION',
        error: 'Duplicate public ID inside selection request.',
      };
    }
    publicIdsSeen.add(pkg.proposedPublicId);

    const m = pkg.manifest;
    if (!m.title || m.title.trim() === '' || m.title.length > 200) {
      return { success: false, code: 'INVALID_SELECTION', error: 'Title is invalid.' };
    }
    if (!m.summary || m.summary.trim() === '' || m.summary.length > 2000) {
      return { success: false, code: 'INVALID_SELECTION', error: 'Summary is invalid.' };
    }

    const yr = Number(m.year);
    if (!Number.isInteger(yr) || yr < 2000 || yr > 2100) {
      return { success: false, code: 'INVALID_SELECTION', error: 'Year must be an integer between 2000 and 2100.' };
    }

    if (!m.program || m.program.trim() === '') {
      return { success: false, code: 'INVALID_SELECTION', error: 'Program is required.' };
    }

    if (!m.groupName || m.groupName.trim() === '') {
      return { success: false, code: 'INVALID_SELECTION', error: 'Group name is required.' };
    }

    if (!Array.isArray(m.teamMembers) || m.teamMembers.length === 0) {
      return { success: false, code: 'INVALID_SELECTION', error: 'Team members list must be a non-empty array.' };
    }

    if (!m.layoutConfig || typeof m.layoutConfig !== 'object' || Array.isArray(m.layoutConfig)) {
      return { success: false, code: 'INVALID_SELECTION', error: 'Layout config must be an object.' };
    }
  }

  // Format packages payload for RPC with zero defaults or fallbacks
  const payloadPackages = selectedPackages.map((pkg) => {
    const m = pkg.manifest!;
    const disciplineList = m.discipline
      ? m.discipline.split(',').map((d) => d.trim()).filter((d) => d !== '')
      : [];
    const categoryList = m.industry
      ? m.industry.split(',').map((c) => c.trim()).filter((c) => c !== '')
      : [];

    return {
      packagePath: pkg.packagePath,
      publicId: pkg.proposedPublicId,
      title: m.title.trim(),
      summary: m.summary.trim(),
      background: m.background ? m.background.trim() : '',
      solution: m.solution ? m.solution.trim() : '',
      year: Number(m.year),
      program: m.program.trim(),
      studyProgram: m.studyProgram ? m.studyProgram.trim() : m.program.trim(),
      industryPartner: m.industryPartner ? m.industryPartner.trim() : '',
      academicSupervisor: m.academicSupervisor ? m.academicSupervisor.trim() : '',
      groupName: m.groupName.trim(),
      teamMembers: m.teamMembers.map((t) => String(t).trim()).filter((t) => t !== ''),
      posterText: m.posterText ? m.posterText.trim() : null,
      accessibilityText: m.accessibilityText ? m.accessibilityText.trim() : null,
      layoutConfig: m.layoutConfig,
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

  // Strict runtime schema validation of RPC response data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The metadata staging operation returned an invalid response.',
    };
  }

  const res = data as Record<string, unknown>;

  if (typeof res.resultCode !== 'string') {
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The metadata staging operation returned an incomplete result code.',
    };
  }

  if (res.resultCode !== 'SUCCESS') {
    const codeStr = res.resultCode;
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

  if (
    typeof res.result !== 'string' ||
    (res.result !== 'created' && res.result !== 'already_staged') ||
    typeof res.batchId !== 'string' ||
    !UUID_REGEX.test(res.batchId) ||
    typeof res.projectCount !== 'number' ||
    !Number.isInteger(res.projectCount) ||
    res.projectCount < 0 ||
    typeof res.warningCount !== 'number' ||
    !Number.isInteger(res.warningCount) ||
    res.warningCount < 0 ||
    res.batchStatus !== 'metadata_staged'
  ) {
    return {
      success: false,
      code: 'PERSISTENCE_FAILED',
      error: 'The metadata staging operation returned an invalid RPC response payload.',
    };
  }

  return {
    success: true,
    result: res.result,
    batchId: res.batchId,
    projectCount: res.projectCount,
    warningCount: res.warningCount,
    batchStatus: 'metadata_staged',
  };
}
