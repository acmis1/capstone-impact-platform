import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { PublicFeedRecord } from '../domain/publicFeed';
import { validatePublicFeed } from './validatePublicFeed';

/**
 * Server/client compatibility proof for the Duda public showcase.
 *
 * The Duda renderer is plain browser script inside `Prototype/duda/bodyend.html`, so its record
 * policy is extracted verbatim from the delimited region of that file and executed here. That keeps
 * a single implementation: this suite cannot drift from what the browser actually runs, and every
 * case below is asserted against BOTH the authoritative `validatePublicFeed` and that exact
 * renderer code.
 */
const bodyEndPath = fileURLToPath(
  new URL('../../../../Prototype/duda/bodyend.html', import.meta.url),
);
const contractCasesPath = fileURLToPath(
  new URL('../../../../Prototype/duda/current-feed-contract-cases.json', import.meta.url),
);

const POLICY_START = '// --- PUBLIC RECORD POLICY (start: extracted verbatim by repository tests) ---';
const POLICY_END = '// --- PUBLIC RECORD POLICY (end) ---';

interface RendererPolicy {
  isSafePublicUrl(rawUrl: unknown, enforcePublicAssetBoundary?: boolean): boolean;
  isPublicSnapshotUrl(rawUrl: unknown): boolean;
  getSnapshotItems(project: unknown): { url: string; altText: string; galleryPosition: number }[];
  normalizeProjectRecord(record: unknown): Record<string, unknown> | null;
}

function loadRendererPolicy(): RendererPolicy {
  const html = readFileSync(bodyEndPath, 'utf8');
  const start = html.indexOf(POLICY_START);
  const end = html.indexOf(POLICY_END);
  if (start < 0 || end <= start) {
    throw new Error('Duda public record policy region was not found in bodyend.html.');
  }
  const source = html.slice(start, end);
  const context: Record<string, unknown> = { URL, decodeURIComponent, console };
  vm.runInNewContext(
    `${source}\n globalThis.__policy = { isSafePublicUrl, isPublicSnapshotUrl, getSnapshotItems, normalizeProjectRecord };`,
    context,
    { filename: bodyEndPath },
  );
  return context.__policy as RendererPolicy;
}

interface ContractCase {
  name: string;
  why: string;
  serverValid: boolean;
  dudaAccepts: boolean;
  dudaGallery: number;
  overrides: Record<string, unknown>;
}

interface ContractCaseFile {
  base: PublicFeedRecord;
  cases: ContractCase[];
}

function loadContractCases(): ContractCaseFile {
  return JSON.parse(readFileSync(contractCasesPath, 'utf8')) as ContractCaseFile;
}

/** Cases replace whole top-level keys of the base record, exactly as the browser harness does. */
export function buildContractCaseRecord(base: PublicFeedRecord, contractCase: ContractCase): PublicFeedRecord {
  return { ...structuredClone(base), ...structuredClone(contractCase.overrides) } as PublicFeedRecord;
}

const policy = loadRendererPolicy();
const { base, cases } = loadContractCases();

describe('Duda renderer and public-feed server contract compatibility', () => {
  it('extracts the renderer policy actually shipped in bodyend.html', () => {
    expect(typeof policy.isSafePublicUrl).toBe('function');
    expect(typeof policy.getSnapshotItems).toBe('function');
    expect(typeof policy.normalizeProjectRecord).toBe('function');
  });

  it('keeps the baseline paired-contract record valid on both sides', () => {
    expect(validatePublicFeed([base])).toMatchObject({ valid: true, errors: [] });
    expect(policy.normalizeProjectRecord(base)).not.toBeNull();
  });

  it.each(cases.map((contractCase) => [contractCase.name, contractCase] as const))(
    'agrees on case %s',
    (_name, contractCase) => {
      const record = buildContractCaseRecord(base, contractCase);
      const serverResult = validatePublicFeed([record]);

      expect(
        serverResult.valid,
        `${contractCase.name}: ${contractCase.why}\nserver errors: ${serverResult.errors.join('; ')}`,
      ).toBe(contractCase.serverValid);

      const normalized = policy.normalizeProjectRecord(record);
      expect(
        normalized !== null,
        `${contractCase.name}: ${contractCase.why}`,
      ).toBe(contractCase.dudaAccepts);

      const gallery = normalized ? (normalized.snapshotMedia as unknown[]) : [];
      expect(
        gallery.length,
        `${contractCase.name}: rendered gallery size`,
      ).toBe(contractCase.dudaGallery);
    },
  );

  it('never rejects a server-valid record because of a stricter invented client rule', () => {
    const disagreements = cases
      .filter((contractCase) => contractCase.serverValid && contractCase.dudaAccepts)
      .filter((contractCase) => policy.normalizeProjectRecord(buildContractCaseRecord(base, contractCase)) === null)
      .map((contractCase) => contractCase.name);

    expect(disagreements).toEqual([]);
  });
});

describe('featuredMedia contract', () => {
  function normalizedLayout(featuredMedia: unknown): Record<string, unknown> | null {
    const record = structuredClone(base) as unknown as Record<string, unknown>;
    record.layoutConfig = { ...(base.layoutConfig as object), featuredMedia };
    const normalized = policy.normalizeProjectRecord(record);
    return normalized ? (normalized.layoutConfig as Record<string, unknown>) : null;
  }

  it('accepts the authoritative "auto" value the import mapping emits', () => {
    expect(normalizedLayout('auto')).toMatchObject({ featuredMedia: 'auto' });
  });

  it.each(['poster', 'snapshots', 'gallery', 'video', 'none'])(
    'preserves the explicit featured media value %s',
    (value) => {
      expect(normalizedLayout(value)).toMatchObject({ featuredMedia: value });
    },
  );

  it('resolves an unrecognized presentation preference to automatic selection instead of rejecting the feed', () => {
    expect(normalizedLayout('carousel')).toMatchObject({ featuredMedia: 'auto' });
  });

  it('still rejects a non-string featured media value', () => {
    expect(normalizedLayout(7)).toBeNull();
  });
});

describe('gallery position contract', () => {
  function galleryOf(name: string) {
    const contractCase = cases.find((entry) => entry.name === name);
    if (!contractCase) throw new Error(`Missing contract case: ${name}`);
    const record = buildContractCaseRecord(base, contractCase);
    return {
      record,
      server: validatePublicFeed([record]),
      normalized: policy.normalizeProjectRecord(record) as Record<string, unknown> | null,
    };
  }

  it('keeps a single server-valid image published at position 2', () => {
    const { server, normalized } = galleryOf('gallery-position-two');
    expect(server.valid).toBe(true);
    expect(normalized?.snapshotMedia).toEqual([
      {
        url: 'https://media.example.test/snapshots/contract-two.jpg',
        altText: 'Sole synthetic gallery image published at governed position two.',
        galleryPosition: 2,
      },
    ]);
  });

  it('keeps non-contiguous server-valid positions 2 and 5 in snapshots display order', () => {
    const { server, normalized } = galleryOf('gallery-positions-two-and-five');
    expect(server.valid).toBe(true);
    expect(normalized?.snapshotMedia).toMatchObject([
      { galleryPosition: 2 },
      { galleryPosition: 5 },
    ]);
    expect(normalized?.snapshots).toEqual([
      'https://media.example.test/snapshots/contract-two.jpg',
      'https://media.example.test/snapshots/contract-five.jpg',
    ]);
  });

  it('never fabricates a gallery position during normalization', () => {
    const record = buildContractCaseRecord(
      base,
      cases.find((entry) => entry.name === 'gallery-positions-two-and-five')!,
    );
    const normalized = policy.normalizeProjectRecord(record) as Record<string, unknown>;
    const positions = (normalized.snapshotMedia as { galleryPosition: number }[]).map(
      (item) => item.galleryPosition,
    );
    expect(positions).not.toEqual([1, 2]);
    expect(positions).toEqual([2, 5]);
  });

  it('normalizes idempotently so a re-rendered record keeps its authoritative positions', () => {
    const record = buildContractCaseRecord(
      base,
      cases.find((entry) => entry.name === 'gallery-positions-two-and-five')!,
    );
    const once = policy.normalizeProjectRecord(record) as Record<string, unknown>;
    expect(policy.getSnapshotItems(once)).toMatchObject([
      { galleryPosition: 2 },
      { galleryPosition: 5 },
    ]);
  });

  it('drops both entries when two surviving images contest one gallery position', () => {
    const contested = {
      snapshots: [
        'https://media.example.test/snapshots/contract-one.jpg',
        'https://media.example.test/snapshots/contract-two.jpg',
      ],
      snapshotMedia: [
        {
          url: 'https://media.example.test/snapshots/contract-one.jpg',
          altText: 'First contradictory alternative.',
          galleryPosition: 3,
        },
        {
          url: 'https://media.example.test/snapshots/contract-two.jpg',
          altText: 'Second contradictory alternative.',
          galleryPosition: 3,
        },
      ],
    };
    expect(validatePublicFeed([{ ...base, ...contested }]).valid).toBe(false);
    expect(policy.getSnapshotItems({ ...base, ...contested })).toEqual([]);
  });

  it('rejects gallery positions outside the governed 1 through 10 range on both sides', () => {
    for (const galleryPosition of [0, 11, 1.5]) {
      const outOfRange = {
        snapshots: ['https://media.example.test/snapshots/contract-one.jpg'],
        snapshotMedia: [
          {
            url: 'https://media.example.test/snapshots/contract-one.jpg',
            altText: 'Out of range gallery entry.',
            galleryPosition,
          },
        ],
      };
      expect(validatePublicFeed([{ ...base, ...outOfRange }]).valid).toBe(false);
      expect(policy.getSnapshotItems({ ...base, ...outOfRange })).toEqual([]);
    }
  });
});

describe('Supabase Storage public URL boundary', () => {
  const acceptedGeneralUrls = [
    'https://www.youtube.com/watch?v=AbCdEfGhI12',
    'https://youtu.be/AbCdEfGhI12',
    'https://vimeo.com/987654321',
    'https://demo.example.test/launch?ref=showcase&mode=public',
    'https://code.example.test/contract-baseline?tab=readme#install',
    'http://demo.example.test/plain',
    'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/poster.jpg',
    'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/gallery%20one.jpg',
  ];

  it.each(acceptedGeneralUrls)('accepts the legitimate public URL %s', (url) => {
    expect(policy.isSafePublicUrl(url)).toBe(true);
  });

  const rejectedUrls: [string, string][] = [
    ['literal private bucket', 'https://demofixture.supabase.co/storage/v1/object/public/project-drafts-private/x.jpg'],
    ['percent-encoded private bucket', 'https://demofixture.supabase.co/storage/v1/object/public/project%2Ddrafts%2Dprivate/x.jpg'],
    ['lower-case encoded private bucket', 'https://demofixture.supabase.co/storage/v1/object/public/project%2ddrafts%2dprivate/x.jpg'],
    ['double-encoded private bucket', 'https://demofixture.supabase.co/storage/v1/object/public/project%252Ddrafts%252Dprivate/x.jpg'],
    ['literal signed route', 'https://demofixture.supabase.co/storage/v1/object/sign/project-public-assets/x.jpg?token=abc'],
    ['encoded signed route', 'https://demofixture.supabase.co/storage/v1/object/%73ign/project-public-assets/x.jpg?token=abc'],
    ['literal authenticated route', 'https://demofixture.supabase.co/storage/v1/object/authenticated/project-public-assets/x.jpg'],
    ['mixed-case encoded authenticated route', 'https://demofixture.supabase.co/storage/v1/object/%41uthenticated/project-public-assets/x.jpg'],
    ['encoded path separator into a private bucket', 'https://demofixture.supabase.co/storage/v1/object/public%2Fproject-drafts-private/x.jpg'],
    ['token-bearing public storage route', 'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/x.jpg?token=abc'],
    ['access token on a Supabase Storage route', 'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/x.jpg?access_token=abc'],
    ['malformed percent-encoding', 'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/x%ZZ.jpg'],
    ['unresolvable repeated encoding', 'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/x%2525252525.jpg'],
    ['signed route on a custom storage host', 'https://cdn.example.test/storage/v1/object/sign/project-public-assets/x.jpg?token=abc'],
    ['embedded credentials', 'https://operator:secret@demo.example.test/launch'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:image/svg+xml,placeholder'],
    ['vbscript scheme', 'vbscript:msgbox(1)'],
    ['relative path', '/storage/v1/object/public/project-public-assets/x.jpg'],
    ['whitespace padded URL', ' https://demo.example.test/launch'],
  ];

  it.each(rejectedUrls)('rejects %s in a generic active URL field', (_label, url) => {
    expect(policy.isSafePublicUrl(url)).toBe(false);
  });

  it.each(rejectedUrls)('rejects %s under the stronger public-asset boundary too', (_label, url) => {
    expect(policy.isSafePublicUrl(url, true)).toBe(false);
  });

  it('keeps the stronger draft-path rule for public asset fields on any host', () => {
    const draftUrl = 'https://media.example.test/drafts/pending-poster.jpg';
    expect(policy.isSafePublicUrl(draftUrl)).toBe(true);
    expect(policy.isSafePublicUrl(draftUrl, true)).toBe(false);
    expect(policy.isPublicSnapshotUrl(draftUrl)).toBe(false);
  });
});
