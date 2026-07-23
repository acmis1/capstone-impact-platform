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
];

export function getRouteDescriptor(pathname: string): RouteDescriptor {
  // Normalize pathname
  const cleanPath = pathname.replace(/\/$/, '') || '/admin';

  // Check imports detail route first: /admin/imports/{batchId}
  if (cleanPath.startsWith('/admin/imports/')) {
    return {
      title: 'Import batch',
      breadcrumbs: [
        { label: 'Imports', href: '/admin/imports' },
        { label: 'Import batch' },
      ],
      activeHref: '/admin/imports',
    };
  }

  // Check exact imports route: /admin/imports
  if (cleanPath === '/admin/imports') {
    return {
      title: 'Import history',
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
