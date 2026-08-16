import { describe, it, expect } from 'vitest';
import {
  validateBrowserImportMediaStageResponse,
} from '../browserImportMediaStageContract';
import { computeCanonicalMediaIntentHash } from '../browserImportMediaStageServer';

describe('computeCanonicalMediaIntentHash', () => {
  const baseParams = {
    batchId: '11111111-1111-1111-1111-111111111111',
    metadataIntentHash: 'a'.repeat(64),
    files: [
      { packagePath: 'root/pkg-a', projectPublicId: 'pkg-a', assetType: 'poster_image', fileName: 'poster.png', fileSizeBytes: 300 },
      { packagePath: 'root/pkg-a', projectPublicId: 'pkg-a', assetType: 'poster_pdf', fileName: 'poster.pdf', fileSizeBytes: 500 },
    ],
  };

  it('is deterministic for the same canonical input', () => {
    const hash1 = computeCanonicalMediaIntentHash(baseParams);
    const hash2 = computeCanonicalMediaIntentHash(baseParams);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is independent of input file array ordering (order-insensitive canonicalization)', () => {
    const reordered = { ...baseParams, files: [...baseParams.files].reverse() };
    expect(computeCanonicalMediaIntentHash(baseParams)).toBe(computeCanonicalMediaIntentHash(reordered));
  });

  it('changes when the batchId differs (binds hash to a specific batch)', () => {
    const other = { ...baseParams, batchId: '22222222-2222-2222-2222-222222222222' };
    expect(computeCanonicalMediaIntentHash(baseParams)).not.toBe(computeCanonicalMediaIntentHash(other));
  });

  it('changes when the metadata intent hash differs (binds to a specific metadata staging attempt)', () => {
    const other = { ...baseParams, metadataIntentHash: 'b'.repeat(64) };
    expect(computeCanonicalMediaIntentHash(baseParams)).not.toBe(computeCanonicalMediaIntentHash(other));
  });

  it('changes when a file is added or removed', () => {
    const fewer = { ...baseParams, files: baseParams.files.slice(0, 1) };
    expect(computeCanonicalMediaIntentHash(baseParams)).not.toBe(computeCanonicalMediaIntentHash(fewer));
  });

  it('changes when a file size differs', () => {
    const tampered = {
      ...baseParams,
      files: baseParams.files.map((f, i) => (i === 0 ? { ...f, fileSizeBytes: f.fileSizeBytes + 1 } : f)),
    };
    expect(computeCanonicalMediaIntentHash(baseParams)).not.toBe(computeCanonicalMediaIntentHash(tampered));
  });
});

describe('validateBrowserImportMediaStageResponse', () => {
  it('accepts a well-formed success response', () => {
    const res = validateBrowserImportMediaStageResponse({
      success: true,
      result: 'completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'completed',
    });
    expect(res).not.toBeNull();
    expect(res?.success).toBe(true);
  });

  it('accepts a well-formed failure response', () => {
    const res = validateBrowserImportMediaStageResponse({
      success: false,
      code: 'STORAGE_CONFLICT',
      error: 'A media storage conflict was detected. Please try again.',
    });
    expect(res).not.toBeNull();
    expect(res?.success).toBe(false);
  });

  it('rejects a success response with an unknown extra key', () => {
    const res = validateBrowserImportMediaStageResponse({
      success: true,
      result: 'completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'completed',
      publicUrl: 'https://example.com/leak.png',
    });
    expect(res).toBeNull();
  });

  it('rejects a failure response with an unrecognized error code', () => {
    const res = validateBrowserImportMediaStageResponse({
      success: false,
      code: 'SOME_MADE_UP_CODE',
      error: 'nope',
    });
    expect(res).toBeNull();
  });

  it('rejects a success response with a malformed batchId', () => {
    const res = validateBrowserImportMediaStageResponse({
      success: true,
      result: 'completed',
      batchId: 'not-a-real-uuid',
      mediaAssetCount: 3,
      batchStatus: 'completed',
    });
    expect(res).toBeNull();
  });

  it('rejects a success response with a negative mediaAssetCount', () => {
    const res = validateBrowserImportMediaStageResponse({
      success: true,
      result: 'completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: -1,
      batchStatus: 'completed',
    });
    expect(res).toBeNull();
  });

  it('rejects a batchStatus other than completed', () => {
    const res = validateBrowserImportMediaStageResponse({
      success: true,
      result: 'completed',
      batchId: '11111111-1111-1111-1111-111111111111',
      mediaAssetCount: 3,
      batchStatus: 'metadata_staged',
    });
    expect(res).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateBrowserImportMediaStageResponse(null)).toBeNull();
    expect(validateBrowserImportMediaStageResponse('nope')).toBeNull();
    expect(validateBrowserImportMediaStageResponse([1, 2, 3])).toBeNull();
  });
});
