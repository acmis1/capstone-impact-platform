import { describe, expect, it } from 'vitest';
import { getPermissionsForRoles } from '../auth/permissions';
import { createMockProject } from '../test/projectFixtures';
import { compilePublicationCandidateFeed } from './compilePublicFeed';
import { serializePublicFeedArtifact } from './serializePublicFeedArtifact';

describe('publication preparation', () => {
  it('limits projects.publish to admins', () => {
    expect(getPermissionsForRoles(['admin'])).toContain('projects.publish');
    expect(getPermissionsForRoles(['reviewer'])).not.toContain('projects.publish');
    expect(getPermissionsForRoles(['editor'])).not.toContain('projects.publish');
  });
  it('includes only baseline and exact target without mutation', () => {
    const input = [createMockProject({ id: 1, publicId: 'baseline', status: 'published' }), createMockProject({ id: 2, publicId: 'target', status: 'approved', internalStaffNotes: 'private' }), createMockProject({ id: 3, publicId: 'other', status: 'approved' })];
    const before = JSON.stringify(input); const feed = compilePublicationCandidateFeed(input, 'target');
    expect(feed.map((record) => record.publicId)).toEqual(['baseline', 'target']); expect(feed[1]).not.toHaveProperty('internalStaffNotes'); expect(JSON.stringify(input)).toBe(before);
  });
  it('fails closed and serializes deterministic canonical bytes', () => {
    expect(() => compilePublicationCandidateFeed([], 'missing')).toThrow();
    const feed = compilePublicationCandidateFeed([createMockProject({ publicId: 'target', status: 'approved' })], 'target');
    expect(serializePublicFeedArtifact(feed)).toEqual(serializePublicFeedArtifact(feed));
  });
});
