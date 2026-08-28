import { PublicFeedRecord } from '../domain/publicFeed';
import { ACCESSIBLE_CONTENT_LIMITS, getAccessibleContentProblem } from '../domain/accessibleContent';
import { STORAGE_POLICIES } from '../storage/storageRules';

export interface FeedValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SNAPSHOT_MEDIA_KEYS = new Set([
  'url',
  'altText',
  'galleryPosition',
]);

const MAX_POLICY_PATH_DECODE_PASSES = 3;

const STORAGE_API_PATH_MARKER = '/storage/v1/';
const PRIVATE_ACCESS_QUERY_KEYS = new Set([
  'token',
  'jwt',
  'apikey',
  'api_key',
  'access_token',
  'authorization',
]);
const PRIVATE_ACCESS_TEXT_PATTERN = /(?:^|[?&#;])(?:token|jwt|apikey|api_key|access_token|authorization)(?:=|&|$)/i;
const PUBLIC_URL_FORBIDDEN_CHARACTERS = /[\u0000-\u0020\u007f<>"'`]/;

interface PercentEncodingState {
  hasPercent: boolean;
  hasEncodedByte: boolean;
  hasMalformedPercent: boolean;
}

function inspectPercentEncoding(value: string): PercentEncodingState {
  let hasPercent = false;
  let hasEncodedByte = false;
  let hasMalformedPercent = false;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    hasPercent = true;
    if (/^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      hasEncodedByte = true;
      index += 2;
    } else {
      hasMalformedPercent = true;
    }
  }

  return { hasPercent, hasEncodedByte, hasMalformedPercent };
}

/**
 * Bounded, explicit path canonicalization for URL policy decisions.
 *
 * A private identifier can survive inside `URL.pathname` in percent-encoded form, so a raw
 * `pathname.includes(...)` check alone is bypassable. Policy markers are therefore matched against
 * the raw path and against a bounded number of decoded forms. This is deliberately not an unbounded
 * recursive decoder: at most `MAX_POLICY_PATH_DECODE_PASSES` passes run. Malformed encoding in the
 * original path fails closed, as does another complete encoded layer beyond the fixed budget. A
 * literal percent produced by decoding `%25` is not itself treated as a malformed extra layer.
 *
 * Returns lower-cased candidate forms, or `null` when the URL must be rejected.
 */
export function canonicalPathForms(pathname: string): string[] | null {
  let current = String(pathname);
  const forms = [current.toLowerCase()];
  for (let pass = 0; pass < MAX_POLICY_PATH_DECODE_PASSES; pass += 1) {
    const encoding = inspectPercentEncoding(current);
    if (!encoding.hasPercent) return forms;
    if (encoding.hasMalformedPercent) {
      // A malformed escape received from the URL is invalid. After at least one successful decode,
      // a lone malformed-looking percent is instead the literal character produced by `%25`.
      // Mixed valid and malformed forms still fail closed because a hidden layer remains.
      return pass > 0 && !encoding.hasEncodedByte ? forms : null;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) return forms;
    current = decoded;
    forms.push(current.toLowerCase());
  }
  return inspectPercentEncoding(current).hasEncodedByte ? null : forms;
}

/**
 * Finds credential-like query or fragment keys after URL parsing and canonical key casing.
 * This is used only for Storage object URLs; ordinary external sites retain unrestricted queries.
 */
function containsPrivateAccessMaterial(parsed: URL): boolean {
  for (const key of parsed.searchParams.keys()) {
    if (PRIVATE_ACCESS_QUERY_KEYS.has(key.toLowerCase())) return true;
  }

  const queryAndFragment = [parsed.search, parsed.hash.slice(1)];
  for (const value of queryAndFragment) {
    let current = value;
    for (let pass = 0; pass <= MAX_POLICY_PATH_DECODE_PASSES; pass += 1) {
      if (PRIVATE_ACCESS_TEXT_PATTERN.test(current)) return true;
      if (!current.includes('%')) break;
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch {
        break;
      }
    }
  }

  return false;
}

function hasPathSegment(pathname: string, segment: string): boolean {
  return pathname.split('/').includes(segment);
}

function hasStorageObjectRoute(pathname: string, route: 'sign' | 'authenticated'): boolean {
  const marker = `/storage/v1/object/${route}`;
  return pathname === marker || pathname.endsWith(marker) || pathname.includes(`${marker}/`);
}

/**
 * One structural public URL policy for every active URL-bearing feed field.
 *
 * All URLs must be absolute credential-free HTTP(S). Storage object URLs are identified from the
 * canonical parsed path, never arbitrary host/query text, then rejected when they expose signed or
 * authenticated routes, private draft paths/buckets, or private-access query/fragment material.
 */
function isPublicSafeUrl(urlStr: unknown): { valid: boolean; reason?: string } {
  if (typeof urlStr !== 'string' || urlStr.trim() === '') {
    return { valid: false, reason: 'URL must be a non-empty string.' };
  }
  if (urlStr.trim() !== urlStr || PUBLIC_URL_FORBIDDEN_CHARACTERS.test(urlStr)) {
    return { valid: false, reason: 'URL contains whitespace or unsafe delimiter characters.' };
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
  if (parsed.username || parsed.password || !parsed.hostname) {
    return { valid: false, reason: 'URL must not contain embedded credentials.' };
  }
  const pathForms = canonicalPathForms(parsed.pathname);
  if (!pathForms) {
    return { valid: false, reason: 'URL path contains malformed or unresolvable percent-encoding.' };
  }

  const isStorageObjectUrl = pathForms.some((form) => form.includes(STORAGE_API_PATH_MARKER));
  if (!isStorageObjectUrl) return { valid: true };

  if (pathForms.some((form) => hasPathSegment(form, 'drafts'))) {
    return { valid: false, reason: 'URL contains private draft path segment "/drafts/".' };
  }
  if (
    pathForms.some((form) => hasPathSegment(form, STORAGE_POLICIES.privateIngestionBucket))
  ) {
    return { valid: false, reason: `URL references private storage bucket "${STORAGE_POLICIES.privateIngestionBucket}".` };
  }
  if (
    pathForms.some(
      (form) =>
        hasStorageObjectRoute(form, 'sign') ||
        hasStorageObjectRoute(form, 'authenticated'),
    )
  ) {
    return { valid: false, reason: 'URL references private or signed storage endpoint.' };
  }
  if (containsPrivateAccessMaterial(parsed)) {
    return { valid: false, reason: 'Supabase Storage URL contains private-access credential material.' };
  }
  return { valid: true };
}

const REQUIRED_ACTIVE_URL_FIELDS = ['poster', 'posterPdf'] as const;
const OPTIONAL_ACTIVE_URL_FIELDS = ['videoUrl', 'demoUrl', 'repositoryUrl'] as const;
const EXTERNAL_LINK_KEYS = new Set(['label', 'url']);

/** Validates every active href/src candidate before a canonical artifact can be accepted. */
function validateActivePublicUrls(record: Record<string, unknown>, prefix: string, errors: string[]): void {
  REQUIRED_ACTIVE_URL_FIELDS.forEach((field) => {
    const value = record[field];
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') {
      errors.push(`${prefix} Type error: "${field}" must be a string URL or an empty string.`);
      return;
    }
    if (!value) return;
    const safety = isPublicSafeUrl(value);
    if (!safety.valid) {
      errors.push(`${prefix} URL field "${field}" is not public-safe: ${safety.reason}`);
    }
  });

  OPTIONAL_ACTIVE_URL_FIELDS.forEach((field) => {
    const value = record[field];
    if (value === undefined) return;
    const safety = isPublicSafeUrl(value);
    if (!safety.valid) {
      errors.push(`${prefix} URL field "${field}" is not public-safe: ${safety.reason}`);
    }
  });

  if (record.externalLinks === undefined) return;
  if (!Array.isArray(record.externalLinks)) {
    errors.push(`${prefix} Type error: "externalLinks" must be an array.`);
    return;
  }

  record.externalLinks.forEach((untypedLink, index) => {
    const linkPrefix = `${prefix} External link [${index}]`;
    if (!untypedLink || typeof untypedLink !== 'object' || Array.isArray(untypedLink)) {
      errors.push(`${linkPrefix} is not a valid object.`);
      return;
    }
    const link = untypedLink as Record<string, unknown>;
    Object.keys(link).forEach((key) => {
      if (!EXTERNAL_LINK_KEYS.has(key)) {
        errors.push(`${linkPrefix} contains unknown field: "${key}".`);
      }
    });
    if (typeof link.label !== 'string') {
      errors.push(`${linkPrefix} is missing a valid "label".`);
    }
    const safety = isPublicSafeUrl(link.url);
    if (!safety.valid) {
      errors.push(`${linkPrefix} URL is not public-safe: ${safety.reason}`);
    }
  });
}

/**
 * Enforces the exact additive `snapshotMedia` contract:
 * 1. snapshots is an array of public-safe string URLs without duplicates.
 * 2. snapshotMedia contains exact { url, altText, galleryPosition } objects.
 * 3. Both arrays contain at most 10 entries and have identical lengths.
 * 4. galleryPosition is a unique integer from 1 through 10.
 * 5. snapshotMedia is ordered by strictly increasing galleryPosition.
 * 6. snapshotMedia[i].url must equal snapshots[i].
 * 7. Every snapshot URL is claimed by exactly one snapshotMedia entry.
 * 8. Every altText is non-blank and within the accessibility safety limit.
 */
function validateSnapshotMedia(record: Record<string, unknown>, prefix: string, errors: string[]): void {
  const snapshotMedia = record.snapshotMedia;
  const snapshots = record.snapshots;

  if (!Array.isArray(snapshots) || !Array.isArray(snapshotMedia)) {
    return;
  }

  if (snapshots.length > 10 || snapshotMedia.length > 10) {
    errors.push(
      `${prefix} Snapshot gallery exceeds the maximum of 10 images.`,
    );
  }

  // 1. Validate each snapshots element: must be string, valid public-safe URL, and unique across snapshots
  const seenSnapshotUrls = new Set<string>();
  const seenGalleryPositions = new Set<number>();
  let previousGalleryPosition = 0;
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

    if (
      typeof item.galleryPosition !== 'number' ||
      !Number.isInteger(item.galleryPosition) ||
      item.galleryPosition < 1 ||
      item.galleryPosition > 10
    ) {
      errors.push(
        `${itemPrefix} is missing a valid "galleryPosition" from 1 through 10.`,
      );
    } else {
      if (seenGalleryPositions.has(item.galleryPosition)) {
        errors.push(
          `${itemPrefix} has duplicate galleryPosition ${item.galleryPosition}.`,
        );
      }

      if (item.galleryPosition <= previousGalleryPosition) {
        errors.push(
          `${itemPrefix} is not in deterministic gallery order.`,
        );
      }

      seenGalleryPositions.add(item.galleryPosition);
      previousGalleryPosition = item.galleryPosition;
    }

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

      const expectedSnapshotUrl = snapshots[itemIndex];

      if (
        typeof expectedSnapshotUrl === 'string' &&
        item.url !== expectedSnapshotUrl
      ) {
        errors.push(
          `${itemPrefix} URL does not match "snapshots" at the same gallery index.`,
        );
      }

      if (!seenSnapshotUrls.has(item.url)) {
        errors.push(
          `${itemPrefix} URL does not match any remaining entry in "snapshots": "${item.url}".`,
        );
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
      if (field === 'id' && (!Number.isSafeInteger(val) || Number(val) <= 0)) {
        errors.push(`${prefix} Type error: "id" must be an integer within the positive safe routing range.`);
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

    // Every value that can become href/src is checked at the authoritative server boundary.
    validateActivePublicUrls(record, prefix, errors);

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
