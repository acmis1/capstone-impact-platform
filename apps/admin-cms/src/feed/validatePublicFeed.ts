import { PublicFeedRecord } from '../domain/publicFeed';

export interface FeedValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates compiled public showcase feed payloads against the approved data contract.
 */
export function validatePublicFeed(feed: unknown[]): FeedValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Allow empty feed payloads but issue a warning
  if (feed.length === 0) {
    warnings.push('Feed contains zero compiled records. Staging feed is currently empty.');
    return { valid: true, errors, warnings };
  }

  const validTemplates = ['poster_showcase', 'technical_detail', 'media_rich'];
  const allowedKeys = new Set([
    'id', 'publicId', 'title', 'summary', 'background', 'solution', 'year',
    'program', 'studyProgram', 'discipline', 'disciplines', 'industry',
    'industryPartner', 'academicSupervisor', 'groupName', 'teamMembers',
    'poster', 'posterPdf', 'posterText', 'accessibilityText', 'snapshots',
    'videoUrl', 'demoUrl', 'repositoryUrl', 'externalLinks', 'citations',
    'layoutConfig'
  ]);

  const forbiddenKeys = new Set([
    'status', 'importBatchId', 'sourceFolder', 'internalStaffNotes',
    'privateReviewComments', 'validationFlags', 'packageValidation',
    'pendingRemovalFromPublic', 'publicRemovalCompletedAt', 'archivedAt',
    'archivedFromStatus', 'archiveReason', 'created_at', 'updated_at'
  ]);

  feed.forEach((untypedRecord, index) => {
    const record = untypedRecord && typeof untypedRecord === 'object' ? (untypedRecord as Record<string, unknown>) : null;
    const recordId = record?.id || `Index_${index}`;
    const prefix = `[Project ${recordId}]`;

    if (!record) {
      errors.push(`${prefix} Record is not a valid JSON object.`);
      return;
    }

    // 2. Reject unknown and forbidden fields (Allow-list validation)
    Object.keys(record).forEach((key) => {
      if (forbiddenKeys.has(key)) {
        errors.push(`${prefix} Forbidden internal administrative field detected: "${key}".`);
      } else if (!allowedKeys.has(key)) {
        errors.push(`${prefix} Unknown schema field detected: "${key}".`);
      }
    });

    // 3. Enforce Required Public Fields
    const requiredFields: (keyof PublicFeedRecord)[] = [
      'id', 'publicId', 'title', 'summary', 'year', 'program', 'studyProgram',
      'discipline', 'groupName', 'teamMembers', 'poster', 'posterPdf',
      'layoutConfig'
    ];

    requiredFields.forEach((field) => {
      const val = record[field];
      if (val === undefined || val === null) {
        errors.push(`${prefix} Missing required field: "${field}".`);
        return;
      }
      
      // Type checks for required fields
      if (field === 'id' && !Number.isInteger(val)) {
        errors.push(`${prefix} Type error: "id" must be an integer.`);
      }
      if (field === 'teamMembers' && !Array.isArray(val)) {
        errors.push(`${prefix} Type error: "teamMembers" must be a string array.`);
      }
      if (field === 'layoutConfig') {
        if (typeof val !== 'object') {
          errors.push(`${prefix} Type error: "layoutConfig" must be an object.`);
        } else {
          const configObj = val as Record<string, unknown>;
          const tId = configObj.templateId;
          if (!tId || typeof tId !== 'string' || !validTemplates.includes(tId)) {
            errors.push(`${prefix} Layout error: "templateId" must be one of [${validTemplates.join(', ')}]. Received "${String(tId)}".`);
          }
        }
      }
    });

    // 4. Recommend Fields for Accessibility & Indexing (Non-blocking warnings)
    const recommendedFields = [
      { name: 'background', desc: 'problem background' },
      { name: 'solution', desc: 'project solution details' },
      { name: 'accessibilityText', desc: 'poster accessibility description' },
      { name: 'posterText', desc: 'poster text content for search indexing' },
      { name: 'academicSupervisor', desc: 'supervisor signature name' },
      { name: 'industryPartner', desc: 'industry corporate partner' },
      { name: 'industry', desc: 'industry categorization tag' },
    ];

    recommendedFields.forEach(({ name, desc }) => {
      const val = record[name];
      if (val === undefined || val === null || String(val).trim() === '') {
        warnings.push(`${prefix} Recommended ${desc} ("${name}") is missing or empty.`);
      }
    });

    const disciplines = record.disciplines;
    if (!Array.isArray(disciplines) || disciplines.length === 0) {
      warnings.push(`${prefix} Recommended disciplines array ("disciplines") is empty.`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
