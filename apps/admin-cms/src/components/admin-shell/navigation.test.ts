import { describe, it, expect } from 'vitest';
import { NAVIGATION_ITEMS, getRouteDescriptor } from './navigation';

describe('navigation module', () => {
  it('defines exact, unique working navigation items', () => {
    expect(NAVIGATION_ITEMS).toEqual([
      { name: 'Projects', href: '/admin' },
      { name: 'Imports', href: '/admin/imports' },
    ]);
    const hrefs = NAVIGATION_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('maps exact /admin to Projects descriptor and activeHref', () => {
    const descriptor = getRouteDescriptor('/admin');
    expect(descriptor).toEqual({
      title: 'Projects',
      breadcrumbs: [{ label: 'Projects' }],
      activeHref: '/admin',
    });
  });

  it('maps /admin/ with trailing slash to Projects descriptor', () => {
    const descriptor = getRouteDescriptor('/admin/');
    expect(descriptor).toEqual({
      title: 'Projects',
      breadcrumbs: [{ label: 'Projects' }],
      activeHref: '/admin',
    });
  });

  it('maps project detail routes to Projects descriptor and activeHref', () => {
    const descriptor = getRouteDescriptor('/admin/projects/PRJ-12345');
    expect(descriptor).toEqual({
      title: 'Project details',
      breadcrumbs: [
        { label: 'Projects', href: '/admin' },
        { label: 'Project details' },
      ],
      activeHref: '/admin',
    });
  });

  it('maps exact /admin/imports to Imports descriptor and activeHref', () => {
    const descriptor = getRouteDescriptor('/admin/imports');
    expect(descriptor).toEqual({
      title: 'Import history',
      breadcrumbs: [{ label: 'Imports' }],
      activeHref: '/admin/imports',
    });
  });

  it('maps import detail routes to Imports descriptor and activeHref', () => {
    const descriptor = getRouteDescriptor('/admin/imports/batch-789');
    expect(descriptor).toEqual({
      title: 'Import batch',
      breadcrumbs: [
        { label: 'Imports', href: '/admin/imports' },
        { label: 'Import batch' },
      ],
      activeHref: '/admin/imports',
    });
  });

  it('ensures /admin/imports is not matched as Projects', () => {
    const importsDescriptor = getRouteDescriptor('/admin/imports');
    expect(importsDescriptor.activeHref).toBe('/admin/imports');

    const importDetailDescriptor = getRouteDescriptor('/admin/imports/batch-1');
    expect(importDetailDescriptor.activeHref).toBe('/admin/imports');
  });

  it('provides generic fallback descriptor for unknown admin routes without throwing', () => {
    const descriptor = getRouteDescriptor('/admin/unknown-section');
    expect(descriptor).toEqual({
      title: 'Administration',
      breadcrumbs: [
        { label: 'Projects', href: '/admin' },
        { label: 'Administration' },
      ],
      activeHref: '/admin',
    });
  });
});
