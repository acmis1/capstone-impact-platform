export interface NavigationItem {
  name: string;
  href: string;
}

export interface RouteDescriptor {
  title: string;
  breadcrumbs: Array<{ label: string; href?: string }>;
  activeHref: string;
}

export const NAVIGATION_ITEMS: NavigationItem[] = [
  { name: 'Projects', href: '/admin' },
  { name: 'Imports', href: '/admin/imports' },
  { name: 'Public feed', href: '/admin/public-feed' },
];

export const STAFF_NAVIGATION_ITEM: NavigationItem = { name: 'Staff access', href: '/admin/staff' };

/**
 * Navigation for a staff member's resolved authority. Omitting the staff-access entry is a
 * usability affordance only — `/admin/staff` and `/api/staff/invitations` each re-authorize on
 * the server, so an unauthorized caller gains nothing by navigating there directly.
 */
export function getNavigationItems(canManageStaff: boolean): NavigationItem[] {
  return canManageStaff ? [...NAVIGATION_ITEMS, STAFF_NAVIGATION_ITEM] : [...NAVIGATION_ITEMS];
}

export function getRouteDescriptor(pathname: string): RouteDescriptor {
  // Normalize pathname
  const cleanPath = pathname.replace(/\/$/, '') || '/admin';

  if (cleanPath === '/admin/public-feed') {
    return {
      title: 'Public deployment history',
      breadcrumbs: [{ label: 'Public feed' }],
      activeHref: '/admin/public-feed',
    };
  }

  // Check exact staff route: /admin/staff
  if (cleanPath === '/admin/staff') {
    return {
      title: 'Staff access',
      breadcrumbs: [{ label: 'Staff access' }],
      activeHref: '/admin/staff',
    };
  }

  // Check exact imports new route: /admin/imports/new
  if (cleanPath === '/admin/imports/new') {
    return {
      title: 'Import projects',
      breadcrumbs: [
        { label: 'Imports', href: '/admin/imports' },
        { label: 'Import projects' },
      ],
      activeHref: '/admin/imports',
    };
  }

  // Check imports detail route: /admin/imports/{batchId}
  if (cleanPath.startsWith('/admin/imports/')) {
    return {
      title: 'Import details',
      breadcrumbs: [
        { label: 'Imports', href: '/admin/imports' },
        { label: 'Import details' },
      ],
      activeHref: '/admin/imports',
    };
  }

  // Check exact imports route: /admin/imports
  if (cleanPath === '/admin/imports') {
    return {
      title: 'Imports',
      breadcrumbs: [{ label: 'Imports' }],
      activeHref: '/admin/imports',
    };
  }

  // Check projects detail route: /admin/projects/{publicId}
  if (cleanPath.startsWith('/admin/projects/')) {
    return {
      title: 'Project details',
      breadcrumbs: [
        { label: 'Projects', href: '/admin' },
        { label: 'Project details' },
      ],
      activeHref: '/admin',
    };
  }

  // Check exact admin / projects root route: /admin
  if (cleanPath === '/admin') {
    return {
      title: 'Projects',
      breadcrumbs: [{ label: 'Projects' }],
      activeHref: '/admin',
    };
  }

  // Fallback for unknown /admin/* routes
  return {
    title: 'Administration',
    breadcrumbs: [
      { label: 'Projects', href: '/admin' },
      { label: 'Administration' },
    ],
    activeHref: '/admin',
  };
}
