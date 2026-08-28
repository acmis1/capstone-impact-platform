import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PublicFeedRecord } from '../domain/publicFeed';
import { validatePublicFeed } from './validatePublicFeed';

const fixturePath = new URL(
  '../../../../Prototype/duda/current-feed-demo-fixture.json',
  import.meta.url,
);

function loadFixture(): PublicFeedRecord[] {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as PublicFeedRecord[];
}

describe('Duda current-feed demonstration fixture', () => {
  it('passes the current public-feed contract with all three layout presets', () => {
    const fixture = loadFixture();

    expect(validatePublicFeed(fixture)).toMatchObject({ valid: true, errors: [] });
    expect(fixture.map((record) => record.layoutConfig.templateId)).toEqual([
      'poster_showcase',
      'technical_detail',
      'media_rich',
    ]);
  });

  it('keeps every compatibility snapshot URL bound to its exact governed alt text', () => {
    for (const record of loadFixture()) {
      expect(record.snapshotMedia).toHaveLength(record.snapshots.length);
      expect(
        record.snapshots.map((url) =>
          record.snapshotMedia.find((media) => media.url === url)?.altText,
        ),
      ).toEqual(record.snapshotMedia.map((media) => media.altText));
    }
  });
});
