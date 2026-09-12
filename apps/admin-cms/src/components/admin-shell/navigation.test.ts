import { describe, it, expect } from 'vitest';
import { NAVIGATION_ITEMS, getNavigationItems, getRouteDescriptor } from './navigation';

describe('navigation module', () => {
  it('defines exact, unique working navigation items', () => {
    expect(NAVIGATION_ITEMS).toEqual([
      { name: 'Projects', href: '/admin' },
      { name: 'Imports', href: '/admin/imports' },
      { name: 'Publishing', href: '/admin/public-feed' },
    ]);
    const hrefs = NAVIGATION_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('maps the public deployment history route to Publishing navigation', () => {
    expect(getRouteDescriptor('/admin/public-feed')).toEqual({
      title: 'Showcase publishing history',
      breadcrumbs: [{ label: 'Publishing' }],
      activeHref: '/admin/public-feed',
    });
  });

  it('shows project categories only to staff with the dedicated taxonomy capability', () => {
    expect(getNavigationItems(false, false)).not.toContainEqual({ name: 'Project categories', href: '/admin/taxonomy' });
    expect(getNavigationItems(false, true)).toContainEqual({ name: 'Project categories', href: '/admin/taxonomy' });
  });

  it('maps the project categories route to its own navigation item', () => {
    expect(getRouteDescriptor('/admin/taxonomy')).toEqual({
      title: 'Project categories',
      breadcrumbs: [{ label: 'Project categories' }],
      activeHref: '/admin/taxonomy',
    });
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
      title: 'Imports',
      breadcrumbs: [{ label: 'Imports' }],
      activeHref: '/admin/imports',
    });
  });

  it('maps /admin/imports/ with trailing slash to Imports descriptor', () => {
    const descriptor = getRouteDescriptor('/admin/imports/');
    expect(descriptor).toEqual({
      title: 'Imports',
      breadcrumbs: [{ label: 'Imports' }],
      activeHref: '/admin/imports',
    });
  });

  it('maps /admin/imports/new to Import projects descriptor and breadcrumbs', () => {
    const descriptor = getRouteDescriptor('/admin/imports/new');
    expect(descriptor).toEqual({
      title: 'Import projects',
      breadcrumbs: [
        { label: 'Imports', href: '/admin/imports' },
        { label: 'Import projects' },
      ],
      activeHref: '/admin/imports',
    });
  });

  it('maps import detail routes to Imports descriptor and activeHref', () => {
    const descriptor = getRouteDescriptor('/admin/imports/batch-789');
    expect(descriptor).toEqual({
      title: 'Import details',
      breadcrumbs: [
        { label: 'Imports', href: '/admin/imports' },
        { label: 'Import details' },
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

  it('verifies descriptor activeHref matches correct NAVIGATION_ITEMS href for Projects & Imports', () => {
    const projectDetail = getRouteDescriptor('/admin/projects/PRJ-001');
    const projectItem = NAVIGATION_ITEMS.find((item) => item.href === projectDetail.activeHref);
    expect(projectItem?.name).toBe('Projects');

    const importDetail = getRouteDescriptor('/admin/imports/batch-002');
    const importItem = NAVIGATION_ITEMS.find((item) => item.href === importDetail.activeHref);
    expect(importItem?.name).toBe('Imports');
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
