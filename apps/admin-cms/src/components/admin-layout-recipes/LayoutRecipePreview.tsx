'use client';

import React from 'react';
import type { LayoutSectionId, ResolvedLayoutConfig } from '../../domain/layoutConfig';
import {
  FEATURED_MEDIA_PRESENTATION,
  getOrderedPreviewSections,
  LAYOUT_SECTION_PRESENTATION,
  LAYOUT_TEMPLATE_PRESENTATION,
  resolveEffectiveFeaturedMedia,
} from '../../domain/layoutPresentation';

type PreviewTextSection = Exclude<LayoutSectionId, 'snapshots' | 'video'>;

const SYNTHETIC_CONTENT: Record<PreviewTextSection, { title: string; body: string }> = {
  background: {
    title: 'Project background / motivation',
    body: 'Synthetic context: a representative project motivation appears here when supplied.',
  },
  solution: {
    title: 'Solution & impact',
    body: 'Synthetic outcome: a representative solution or impact statement appears here when supplied.',
  },
  team: {
    title: 'Team & group',
    body: 'Representative team and group context is always present in this preview.',
  },
  links: {
    title: 'Project resources',
    body: 'Representative demo and repository links would appear here when supplied.',
  },
  citations: {
    title: 'Citations / references',
    body: 'Representative sources and further reading would appear here when supplied.',
  },
  accessibilityText: {
    title: 'Poster accessibility description',
    body: 'Representative poster alt text is shown here; it is distinct from the full poster transcript.',
  },
};

function PreviewSection({ section }: { section: PreviewTextSection }) {
  const content = SYNTHETIC_CONTENT[section];
  return (
    <section data-layout-section={section} className="border-t border-current/15 pt-3">
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] opacity-70">
        {LAYOUT_SECTION_PRESENTATION[section].label}
      </p>
      <h4 className="section-title mt-1 text-sm font-bold">{content.title}</h4>
      <p className="section-text mt-1 text-sm leading-relaxed opacity-85">{content.body}</p>
    </section>
  );
}

export function LayoutRecipePreview({ config }: { config: ResolvedLayoutConfig }) {
  const [sample, setSample] = React.useState<'rich' | 'poster-only'>('rich');
  const headingId = React.useId();
  const rich = sample === 'rich';
  const effectiveFeaturedMedia = resolveEffectiveFeaturedMedia(config, { poster: true, snapshots: rich, video: rich && !config.hiddenSections.includes('video') });
  const orderedSections = getOrderedPreviewSections(config, effectiveFeaturedMedia).filter(section => rich || section === 'team' || section === 'accessibilityText');
  const template = LAYOUT_TEMPLATE_PRESENTATION[config.templateId];
  const presetClass = `layout-preset-${config.templateId}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id={headingId} className="text-lg font-semibold">Representative public preview</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Synthetic illustrative content only — this is not project or publication proof.
          </p>
        </div>
        <span className="text-xs font-semibold text-muted-foreground">{template.label}</span>
      </div>

      <label className="flex flex-col gap-1 text-sm">Example content
        <select aria-label="Example content" value={sample} onChange={event => setSample(event.target.value as 'rich' | 'poster-only')} className="h-10 rounded-md border border-input bg-background px-3">
          <option value="rich">Poster, gallery, video and optional text</option><option value="poster-only">Poster and required content only</option>
        </select>
      </label>
      <div
        data-preset={config.templateId}
        className={`${presetClass} cip-module rounded-xl border p-4 shadow-sm transition-colors sm:p-5 ${
          config.templateId === 'technical_detail'
            ? 'border-stone-300 bg-stone-50 text-slate-900 font-serif'
            : config.templateId === 'media_rich'
              ? 'border-blue-400/40 bg-slate-950 text-slate-50'
              : 'border-orange-200/20 bg-stone-950 text-stone-50'
        }`}
      >
        <header data-layout-region="fixed" className={`${config.templateId}-header detail-header`}>
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] opacity-70">Fixed project header</p>
          <h3 className="mt-2 text-2xl font-extrabold tracking-tight">Synthetic Capstone Project</h3>
          <p className="detail-meta mt-2 text-xs opacity-70">Project ID: example-project · 2026 · Computing</p>
          <p className="lead-summary mt-4 max-w-2xl text-sm leading-relaxed">
            Required summary region: a representative short public summary remains fixed above recipe-controlled sections.
          </p>
        </header>

        {effectiveFeaturedMedia && (
          <section data-layout-region="featured" data-featured-media={effectiveFeaturedMedia} className="mt-4 rounded-lg border border-current/15 p-3">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] opacity-70">Featured media</p>
            <h4 className="mt-1 text-sm font-bold">{FEATURED_MEDIA_PRESENTATION[effectiveFeaturedMedia]}</h4>
            {effectiveFeaturedMedia === 'poster' && (
              <div className="poster-img mt-3 flex min-h-24 items-center justify-center rounded-md bg-gradient-to-br from-rose-400/80 via-orange-300/70 to-amber-100/80 px-4 text-center text-xs font-semibold text-slate-900">
                Synthetic poster image placeholder
              </div>
            )}
            {effectiveFeaturedMedia === 'snapshots' && (
              <div className="snapshot-grid mt-3 grid grid-cols-2 gap-2">
                {['Snapshot 1', 'Snapshot 2'].map((label) => (
                  <div key={label} className="snapshot-card flex min-h-16 items-end rounded-md bg-cyan-300/70 p-2 text-xs font-semibold text-slate-900">
                    {label} · synthetic
                  </div>
                ))}
              </div>
            )}
            {effectiveFeaturedMedia === 'video' && (
              <div className="cip-video-frame mt-3 flex min-h-20 items-center justify-center rounded-md bg-indigo-400/40 px-4 text-center text-xs">
                Synthetic video frame placeholder; no external media request or iframe.
              </div>
            )}
          </section>
        )}

        <div data-layout-region="ordered" className="mt-4 flex flex-col gap-4">
          {orderedSections.map(section => {
            if (section === 'snapshots' || section === 'video') return (
              <section key={section} data-layout-section={section} className="border-t border-current/15 pt-3">
                <h4 className="text-sm font-semibold">{LAYOUT_SECTION_PRESENTATION[section].label}</h4>
                <p className="mt-1 text-sm opacity-85">Synthetic {section === 'snapshots' ? 'snapshot gallery' : 'project video'} in its configured position, not promoted to featured media.</p>
              </section>
            );
            return <PreviewSection key={section} section={section} />;
          })}
        </div>

        <section data-layout-region="poster" className="poster-body mt-4 border-t border-current/15 pt-3">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] opacity-70">Fixed poster region</p>
          <p className="mt-1 text-sm opacity-85">
            The required poster region remains available. Poster transcript and poster accessibility description are separate fields.
          </p>
        </section>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Effective feature: <span className="font-semibold text-foreground">{effectiveFeaturedMedia ? FEATURED_MEDIA_PRESENTATION[effectiveFeaturedMedia] : 'None'}</span>.
        {' '}If selected media is absent in a real project, the maintained renderer falls back to available video, then snapshots, then poster.
        {' '}{template.description}
      </p>
    </section>
  );
}
