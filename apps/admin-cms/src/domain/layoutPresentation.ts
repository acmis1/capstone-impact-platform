import type { LayoutSectionId, LayoutTemplateId, ResolvedLayoutConfig } from './layoutConfig';

export const LAYOUT_SECTION_PRESENTATION: Record<LayoutSectionId, {
  label: string;
  helper: string;
  optional: boolean;
}> = {
  background: {
    label: 'Project background / motivation',
    helper: 'Optional project background or motivation; it is not the poster.',
    optional: true,
  },
  solution: {
    label: 'Solution & impact',
    helper: 'Optional solution or impact; it is not the required public summary.',
    optional: true,
  },
  snapshots: {
    label: 'Snapshot gallery',
    helper: 'When supplied, the gallery cannot be hidden; it follows section order unless featured.',
    optional: false,
  },
  video: {
    label: 'Project video',
    helper: 'Optional video; featuring it pulls it out of ordinary section order.',
    optional: true,
  },
  team: {
    label: 'Team & group',
    helper: 'Required context region; it cannot be hidden.',
    optional: false,
  },
  links: {
    label: 'Project resources',
    helper: 'Optional links to the project demo, repository, or other resources.',
    optional: true,
  },
  citations: {
    label: 'Citations / references',
    helper: 'Optional sources and further reading.',
    optional: true,
  },
  accessibilityText: {
    label: 'Poster accessibility description',
    helper: 'Required poster alt text; distinct from the full poster transcript.',
    optional: false,
  },
};

export const LAYOUT_TEMPLATE_PRESENTATION: Record<LayoutTemplateId, {
  label: string;
  description: string;
  featured: string;
}> = {
  poster_showcase: {
    label: 'Poster showcase',
    description: 'Poster-led opening with project story sections following.',
    featured: 'Poster image',
  },
  technical_detail: {
    label: 'Technical detail',
    description: 'Report-oriented opening with snapshot evidence brought forward.',
    featured: 'Snapshot gallery',
  },
  media_rich: {
    label: 'Media rich',
    description: 'Video and snapshot evidence lead the project story.',
    featured: 'Project video',
  },
};

export const FEATURED_MEDIA_PRESENTATION: Record<ResolvedLayoutConfig['featuredMedia'], string> = {
  auto: 'Automatic fallback',
  poster: 'Poster image',
  snapshots: 'Snapshot gallery',
  video: 'Project video',
  none: 'No featured media',
};

export type PreviewMediaAvailability = {
  poster: boolean;
  snapshots: boolean;
  video: boolean;
};

const DEFAULT_PREVIEW_MEDIA: PreviewMediaAvailability = { poster: true, snapshots: true, video: true };

export function resolveEffectiveFeaturedMedia(
  config: ResolvedLayoutConfig,
  available: PreviewMediaAvailability = DEFAULT_PREVIEW_MEDIA,
): 'poster' | 'snapshots' | 'video' | null {
  const visible = { ...available, video: available.video && !config.hiddenSections.includes('video') };
  // Match the maintained renderer: poster-only projects retain their poster even with no preferred feature.
  if (config.featuredMedia === 'none') return visible.poster && !visible.video && !visible.snapshots ? 'poster' : null;
  const preferred = config.featuredMedia === 'auto' ? null : config.featuredMedia;
  if (preferred && visible[preferred]) return preferred;
  if (visible.video) return 'video';
  if (visible.snapshots) return 'snapshots';
  if (visible.poster) return 'poster';
  return null;
}

export function getOrderedPreviewSections(
  config: ResolvedLayoutConfig,
  effectiveFeaturedMedia: ReturnType<typeof resolveEffectiveFeaturedMedia>,
): LayoutSectionId[] {
  return config.sectionOrder.filter((section) => {
    if (config.hiddenSections.some(hidden => hidden === section)) return false;
    if (section === 'snapshots' && effectiveFeaturedMedia === 'snapshots') return false;
    if (section === 'video' && effectiveFeaturedMedia === 'video') return false;
    return true;
  });
}
