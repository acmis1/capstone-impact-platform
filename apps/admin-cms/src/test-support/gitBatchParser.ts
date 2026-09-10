import { execFileSync } from 'node:child_process';

const MAX_GIT_BATCH_OUTPUT_BYTES = 8 * 1024 * 1024;
const MIGRATIONS_PATH = 'infra/supabase/migrations';

export function listGitMigrationFilenames(root: string, revision: string): string[] {
  if (!revision || /[\r\n\0]/.test(revision)) {
    throw new Error('GIT_TREE_INVALID_REVISION');
  }

  const output = execFileSync('git', ['ls-tree', '-r', '--name-only', '--full-tree', revision, '--', MIGRATIONS_PATH], {
    cwd: root,
    maxBuffer: MAX_GIT_BATCH_OUTPUT_BYTES,
    timeout: 10_000,
  }) as Buffer;
  const prefix = `${MIGRATIONS_PATH}/`;
  const paths = output.toString('utf8').split(/\r?\n/).filter(Boolean);

  if (paths.some((file) => !file.startsWith(prefix) || file.slice(prefix.length).includes('/'))) {
    throw new Error('GIT_TREE_MALFORMED_PATH');
  }

  return paths.map((file) => file.slice(prefix.length)).sort();
}

export function parseGitBatchObjects(output: Buffer, expectedObjectCount: number): Buffer[] {
  if (!Number.isSafeInteger(expectedObjectCount) || expectedObjectCount < 0) {
    throw new Error('GIT_BATCH_INVALID_OBJECT_COUNT');
  }

  const objects: Buffer[] = [];
  let offset = 0;

  for (let index = 0; index < expectedObjectCount; index += 1) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      throw new Error('GIT_BATCH_MALFORMED_HEADER');
    }

    const header = output.subarray(offset, headerEnd).toString('utf8');
    offset = headerEnd + 1;

    if (/^.+ missing$/.test(header)) {
      throw new Error('GIT_BATCH_OBJECT_MISSING');
    }

    const match = /^(?:[a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
    if (!match) {
      throw new Error('GIT_BATCH_MALFORMED_HEADER');
    }

    const size = Number(match[1]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('GIT_BATCH_INVALID_OBJECT_SIZE');
    }

    const bodyEnd = offset + size;
    if (bodyEnd >= output.length || output[bodyEnd] !== 0x0a) {
      throw new Error('GIT_BATCH_MALFORMED_BODY');
    }

    objects.push(output.subarray(offset, bodyEnd));
    offset = bodyEnd + 1;
  }

  if (offset !== output.length) {
    throw new Error('GIT_BATCH_UNEXPECTED_OUTPUT');
  }

  return objects;
}

export function readGitMigrationObjects(root: string, references: readonly string[]): Buffer[] {
  if (references.length === 0) {
    return [];
  }

  if (references.some((reference) => !reference || /[\r\n\0]/.test(reference))) {
    throw new Error('GIT_BATCH_INVALID_REFERENCE');
  }
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: Buffer.from(`${references.join('\n')}\n`, 'utf8'),
    maxBuffer: MAX_GIT_BATCH_OUTPUT_BYTES,
    timeout: 10_000,
  }) as Buffer;

  return parseGitBatchObjects(output, references.length);
}
