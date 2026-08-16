import { PublicFeedRecord } from '../domain/publicFeed';
import { ACCESSIBLE_CONTENT_LIMITS, getAccessibleContentProblem } from '../domain/accessibleContent';
import { STORAGE_POLICIES } from '../storage/storageRules';

export interface FeedValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SNAPSHOT_MEDIA_KEYS = new Set(['url', 'altText']);

/**
 * Validates that a public snapshot URL is a legitimate, public-safe, absolute HTTP(S) URL.
 * Rejects malformed URLs, relative paths, non-http(s) schemes (javascript:, data:, etc.),
 * private draft paths (/drafts/), authenticated/signed storage endpoints, and references
 * to the private ingestion bucket.
 */
function isPublicSafeUrl(urlStr: string): { valid: boolean; reason?: string } {
  if (typeof urlStr !== 'string' || urlStr.trim() === '') {
    return { valid: false, reason: 'URL must be a non-empty string.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { valid: false, reason: 'URL is malformed or not an absolute URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: `URL protocol "${parsed.protocol}" is not public-safe (must be http: or https:).` };
  }
  if (urlStr.includes('/drafts/')) {
    return { valid: false, reason: 'URL contains private draft path segment "/drafts/".' };
  }
  if (urlStr.includes(STORAGE_POLICIES.privateIngestionBucket)) {
    return { valid: false, reason: `URL references private storage bucket "${STORAGE_POLICIES.privateIngestionBucket}".` };
  }
  if (
    parsed.pathname.includes('/storage/v1/object/sign/') ||
    parsed.pathname.includes('/storage/v1/object/authenticated/')
  ) {
    return { valid: false, reason: 'URL references private or signed storage endpoint.' };
  }
  return { valid: true };
}

/**
 * Enforces the exact additive `snapshotMedia` contract:
 * 1. snapshots is an array of public-safe string URLs without duplicates.
 * 2. snapshotMedia is an array of exact { url, altText } objects without duplicates.
 * 3. snapshotMedia length equals snapshots length.
 * 4. Every snapshotMedia URL corresponds to exactly one snapshots URL (order-independent).
 * 5. Every snapshots URL is claimed by exactly one snapshotMedia entry.
 * 6. Every altText is a string, non-blank after trim, <= 2,000 characters.
 */
function validateSnapshotMedia(record: Record<string, unknown>, prefix: string, errors: string[]): void {
  const snapshotMedia = record.snapshotMedia;
  const snapshots = record.snapshots;

  if (!Array.isArray(snapshots) || !Array.isArray(snapshotMedia)) {
    return;
  }

  // 1. Validate each snapshots element: must be string, valid public-safe URL, and unique across snapshots
  const seenSnapshotUrls = new Set<string>();
  snapshots.forEach((url, i) => {
    if (typeof url !== 'string') {
      errors.push(`${prefix} Snapshot URL at index [${i}] must be a string.`);
      return;
    }
    const safety = isPublicSafeUrl(url);
    if (!safety.valid) {
      errors.push(`${prefix} Snapshot URL at index [${i}] is not public-safe: ${safety.reason}`);
    }
    if (seenSnapshotUrls.has(url)) {
      errors.push(`${prefix} Duplicate snapshot URL detected in "snapshots": "${url}".`);
    }
    seenSnapshotUrls.add(url);
  });

  // 2. Validate array length equivalence
  if (snapshotMedia.length !== snapshots.length) {
    errors.push(
      `${prefix} Snapshot media error: "snapshotMedia" has ${snapshotMedia.length} entr${snapshotMedia.length === 1 ? 'y' : 'ies'} but "snapshots" has ${snapshots.length}. Every snapshot image must be paired with a text alternative.`,
    );
  }

  // 3. Validate each snapshotMedia item
  const seenMediaUrls = new Set<string>();
  const unclaimedSnapshotUrls = new Set(seenSnapshotUrls);

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
      const safety = isPublicSafeUrl(item.url);
      if (!safety.valid) {
        errors.push(`${itemPrefix} URL is not public-safe: ${safety.reason}`);
      }
      if (seenMediaUrls.has(item.url)) {
        errors.push(`${itemPrefix} Duplicate URL detected in "snapshotMedia": "${item.url}".`);
      }
      seenMediaUrls.add(item.url);

      if (!seenSnapshotUrls.has(item.url)) {
        errors.push(`${itemPrefix} URL does not match any remaining entry in "snapshots": "${item.url}".`);
      } else {
        unclaimedSnapshotUrls.delete(item.url);
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

  unclaimedSnapshotUrls.forEach((url) => {
    errors.push(`${prefix} Snapshot image is published without a text alternative: "${url}".`);
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
      'posterText', 'accessibilityText', 'snapshots', 'snapshotMedia', 'layoutConfig'
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
      if (field === 'snapshots' && !Array.isArray(val)) {
        errors.push(`${prefix} Type error: "snapshots" must be a string array.`);
      }
      if (field === 'snapshotMedia' && !Array.isArray(val)) {
        errors.push(`${prefix} Type error: "snapshotMedia" must be an array.`);
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
