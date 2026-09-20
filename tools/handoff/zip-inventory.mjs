// Bounded reader for the raw entry inventory of a handoff package archive.
//
// The verifier must judge the archive's *original* entry names, not the names a ZIP library
// presents after it has normalised `..` segments or replaced duplicates. JSZip (and most
// libraries) discard that information on load, so this module reads the central directory and
// local headers directly. It is deliberately not a general ZIP implementation: it supports only
// the single-disk, non-ZIP64, unencrypted, store/deflate archives that build-handoff-package.mjs
// generates and rejects anything else instead of guessing.
import path from 'node:path';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const SUPPORTED_METHODS = new Set([0, 8]);
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const UNIX_MADE_BY = 3;
const UNIX_SYMLINK = 0o120000;
const UNIX_TYPE_MASK = 0o170000;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export class UnsupportedZipError extends Error {}

function decodeName(bytes, flags) {
  if (flags & FLAG_UTF8) {
    try {
      return strictUtf8.decode(bytes);
    } catch {
      throw new UnsupportedZipError('entry name is not valid UTF-8');
    }
  }
  for (const byte of bytes) {
    if (byte >= 0x80) throw new UnsupportedZipError('entry name uses a non-ASCII byte without the UTF-8 flag');
  }
  return bytes.toString('latin1');
}

/** Locates the single end-of-central-directory record and rejects trailing data or ZIP64 archives. */
function readEndOfCentralDirectory(bytes) {
  if (bytes.length < EOCD_MIN_LENGTH) throw new UnsupportedZipError('archive is too small to be a ZIP file');
  const lowest = Math.max(0, bytes.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  let offset = -1;
  for (let candidate = bytes.length - EOCD_MIN_LENGTH; candidate >= lowest; candidate -= 1) {
    if (bytes.readUInt32LE(candidate) !== EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(candidate + 20);
    if (candidate + EOCD_MIN_LENGTH + commentLength === bytes.length) { offset = candidate; break; }
  }
  if (offset < 0) throw new UnsupportedZipError('end-of-central-directory record not found or archive has trailing data');
  if (offset >= 20 && bytes.readUInt32LE(offset - 20) === ZIP64_LOCATOR_SIGNATURE) {
    throw new UnsupportedZipError('ZIP64 archives are not supported');
  }
  const record = {
    diskNumber: bytes.readUInt16LE(offset + 4),
    centralDirectoryDisk: bytes.readUInt16LE(offset + 6),
    entriesOnDisk: bytes.readUInt16LE(offset + 8),
    totalEntries: bytes.readUInt16LE(offset + 10),
    centralDirectorySize: bytes.readUInt32LE(offset + 12),
    centralDirectoryOffset: bytes.readUInt32LE(offset + 16),
    commentLength: bytes.readUInt16LE(offset + 20),
    offset,
  };
  if (record.diskNumber !== 0 || record.centralDirectoryDisk !== 0) throw new UnsupportedZipError('multi-disk archives are not supported');
  if (record.entriesOnDisk !== record.totalEntries) throw new UnsupportedZipError('inconsistent entry counts in the end-of-central-directory record');
  if (record.totalEntries === 0xffff || record.centralDirectorySize === 0xffffffff || record.centralDirectoryOffset === 0xffffffff) {
    throw new UnsupportedZipError('ZIP64 field markers are not supported');
  }
  if (record.centralDirectoryOffset + record.centralDirectorySize !== offset) {
    throw new UnsupportedZipError('central directory does not end at the end-of-central-directory record');
  }
  return record;
}

/**
 * Reads every central-directory entry in order and cross-checks each local header. Returns the
 * raw entries exactly as stored; nothing is normalised. Throws UnsupportedZipError for any
 * structure outside the supported generated format.
 */
export function readRawZipInventory(bytes) {
  const eocd = readEndOfCentralDirectory(bytes);
  const entries = [];
  let cursor = eocd.centralDirectoryOffset;
  const end = cursor + eocd.centralDirectorySize;
  while (cursor < end) {
    if (end - cursor < 46 || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new UnsupportedZipError('malformed central directory entry');
    const versionMadeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (cursor + recordLength > end) throw new UnsupportedZipError('central directory entry overruns the central directory');
    if (nameLength === 0) throw new UnsupportedZipError('entry with an empty name');
    if (diskStart !== 0) throw new UnsupportedZipError('multi-disk entry');
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new UnsupportedZipError('encrypted entries are not supported');
    if (!SUPPORTED_METHODS.has(method)) throw new UnsupportedZipError(`compression method ${method} is not supported`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) throw new UnsupportedZipError('ZIP64 entry fields are not supported');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeName(nameBytes, flags);

    if (localHeaderOffset + 30 > eocd.centralDirectoryOffset || bytes.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) {
      throw new UnsupportedZipError(`local header missing for ${name}`);
    }
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const localNameBytes = bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength);
    if (!localNameBytes.equals(nameBytes)) throw new UnsupportedZipError(`local header name differs from the central directory name for ${name}`);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > eocd.centralDirectoryOffset) throw new UnsupportedZipError(`entry data overruns the archive for ${name}`);

    const madeByPlatform = versionMadeBy >> 8;
    const unixMode = madeByPlatform === UNIX_MADE_BY ? (externalAttributes >>> 16) & UNIX_TYPE_MASK : null;
    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      isSymlink: unixMode === UNIX_SYMLINK,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += recordLength;
  }
  if (cursor !== end) throw new UnsupportedZipError('central directory size does not match its entries');
  if (entries.length !== eocd.totalEntries) throw new UnsupportedZipError(`central directory holds ${entries.length} entries but the record declares ${eocd.totalEntries}`);
  return { entries, totalEntries: eocd.totalEntries };
}

/**
 * Judges raw names before anything is normalised or extracted. Every problem is reported; an
 * archive with any problem must not be extracted.
 */
export function validateRawInventory(entries, validateEntryName) {
  const problems = [];
  const seenRaw = new Set();
  const normalisedOwners = new Map();
  for (const entry of entries) {
    const { name } = entry;
    for (const problem of validateEntryName(name, seenRaw)) problems.push(`entry ${name}: ${problem}`);
    if (entry.isDirectory) problems.push(`entry ${name}: directory entries are not part of the generated format`);
    if (entry.isSymlink) problems.push(`entry ${name}: symbolic link`);
    if (name.split('/').some((segment) => segment === '.' || segment === '..') || name.includes('//')) {
      problems.push(`entry ${name}: non-normalized path`);
    }
    const normalised = path.posix.normalize(name);
    const owner = normalisedOwners.get(normalised);
    if (owner !== undefined && owner !== name) problems.push(`entry ${name}: extraction target collides with ${owner}`);
    else normalisedOwners.set(normalised, name);
  }
  return problems;
}
