import { PublicFeedRecord } from '../domain/publicFeed';
import { ACCESSIBLE_CONTENT_LIMITS, getAccessibleContentProblem } from '../domain/accessibleContent';

export interface FeedValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SNAPSHOT_MEDIA_KEYS = new Set(['url', 'altText']);

/**
 * Enforces the additive `snapshotMedia` contract: an array that corresponds exactly to `snapshots`,
 * one entry per public snapshot URL, each carrying a bounded non-blank text alternative.
 *
 * Correspondence is checked by URL rather than by position, and each `snapshots` entry may be
 * claimed only once, so neither reordering nor a duplicated entry can satisfy the pairing. The
 * public-safety rules that already apply to `snapshots` therefore apply here too — a private or
 * draft URL cannot appear in `snapshotMedia` without also appearing in `snapshots`, where the
 * existing artifact-level private-reference check rejects it.
 */
function validateSnapshotMedia(record: Record<string, unknown>, prefix: string, errors: string[]): void {
  const snapshotMedia = record.snapshotMedia;
  const snapshots = record.snapshots;

  if (!Array.isArray(snapshotMedia)) {
    errors.push(`${prefix} Type error: "snapshotMedia" must be an array.`);
    return;
  }
  if (!Array.isArray(snapshots)) {
    // The snapshots type error is reported by the caller's required-field pass; without it there is
    // nothing to pair against, so pairing is not additionally re-reported here.
    return;
  }

  if (snapshotMedia.length !== snapshots.length) {
    errors.push(
      `${prefix} Snapshot media error: "snapshotMedia" has ${snapshotMedia.length} entr${snapshotMedia.length === 1 ? 'y' : 'ies'} but "snapshots" has ${snapshots.length}. Every snapshot image must be paired with a text alternative.`,
    );
  }

  const unclaimedUrls = [...snapshots];

  snapshotMedia.forEach((untypedItem, itemIndex) => {
    const itemPrefix = `${prefix} Snapshot media [${itemIndex}]`;
    if (!untypedItem || typeof untypedItem !== 'object' || Array.isArray(untypedItem)) {
      errors.push(`${itemPrefix} is not a valid object.`);
      return;
    }

    const item = untypedItem as Record<string, unknown>;
    const keys = Object.keys(item);
    keys.forEach((key) => {
      if (!SNAPSHOT_MEDIA_KEYS.has(key)) {
        errors.push(`${itemPrefix} contains unknown field: "${key}".`);
      }
    });

    if (typeof item.url !== 'string' || item.url.trim() === '') {
      errors.push(`${itemPrefix} is missing a valid "url".`);
    } else {
      const claimedAt = unclaimedUrls.indexOf(item.url);
      if (claimedAt === -1) {
        errors.push(`${itemPrefix} URL does not match any remaining entry in "snapshots".`);
      } else {
        unclaimedUrls.splice(claimedAt, 1);
      }
    }

    if (typeof item.altText !== 'string') {
      errors.push(`${itemPrefix} is missing a valid "altText".`);
      return;
    }
    const problem = getAccessibleContentProblem(item.altText, 'snapshotAltText');
    if (problem === 'MISSING') {
      errors.push(`${itemPrefix} has an empty "altText". A published snapshot image must be described.`);
    } else if (problem === 'TOO_LONG') {
      errors.push(
        `${itemPrefix} "altText" exceeds the ${ACCESSIBLE_CONTENT_LIMITS.snapshotAltText.toLocaleString('en-US')} character safety limit.`,
      );
    }
  });

  unclaimedUrls.forEach((url) => {
    errors.push(`${prefix} Snapshot image is published without a text alternative: "${String(url)}".`);
  });
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
    'snapshotMedia',
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
      'posterText', 'accessibilityText', 'layoutConfig'
    ];

    /**
     * A public project page must carry a full text version of its image content and a text
     * alternative for the poster image. A record that reaches the feed without either is invalid,
     * not merely suboptimal — an empty string would publish an image with no accessible equivalent.
     */
    const accessibleContentFields: (keyof PublicFeedRecord)[] = ['posterText', 'accessibilityText'];

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
      if (accessibleContentFields.includes(field)) {
        // A public artifact must carry accessible content, and it must stay bounded — an unbounded
        // value would bloat the compiled feed the Duda showcase consumes.
        const accessibleField = field as 'posterText' | 'accessibilityText';
        const problem = getAccessibleContentProblem(typeof val === 'string' ? val : String(val), accessibleField);
        if (problem === 'MISSING') {
          errors.push(`${prefix} Required field "${field}" is empty. Public records must include accessible poster content.`);
        } else if (problem === 'TOO_LONG') {
          errors.push(`${prefix} Required field "${field}" exceeds the ${ACCESSIBLE_CONTENT_LIMITS[accessibleField].toLocaleString('en-US')} character safety limit.`);
        }
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

    // 3b. Structured snapshot media. Every published snapshot image must reach the public feed
    // paired with a usable text alternative, and the pairing must be exact — an image described by
    // the wrong entry is no better than an undescribed one, so URL correspondence is verified
    // rather than assumed from array order.
    validateSnapshotMedia(record, prefix, errors);

    // 4. Recommend Fields for Accessibility & Indexing (Non-blocking warnings)
    const recommendedFields = [
      { name: 'background', desc: 'problem background' },
      { name: 'solution', desc: 'project solution details' },
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
