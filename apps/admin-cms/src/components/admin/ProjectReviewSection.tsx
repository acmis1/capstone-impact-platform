import React from 'react';
import { ChevronRight, LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Visual weight of a project-detail section.
 *
 * The project-detail workspace deliberately does not give every section the same container.
 * `surface` is the ordinary review section, `emphasis` marks the one active workflow decision
 * area, and `plain` carries reading/evidence content that reads better without another box
 * around it.
 */
export type ProjectReviewSectionTone = 'surface' | 'emphasis' | 'plain';

interface ProjectReviewSectionProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  tone?: ProjectReviewSectionTone;
  headingLevel?: 'h2' | 'h3' | 'h4';
  id?: string;
  /**
   * Renders the body inside a native `<details>` disclosure. Native semantics are used
   * deliberately: the expanded/collapsed state and its relationship to the revealed content
   * come from the platform, and no client JavaScript is required for a server-rendered section.
   */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Short hint rendered next to the summary chevron, e.g. a record count. */
  collapsedHint?: string;
}

interface ProjectDetailMacroSectionProps {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}

const TONE_CONTAINER: Record<ProjectReviewSectionTone, string> = {
  surface: 'rounded-xl border border-border bg-card',
  emphasis: 'rounded-xl border border-border-strong bg-card shadow-sm',
  plain: '',
};

const TONE_PADDING: Record<ProjectReviewSectionTone, string> = {
  surface: 'p-4 sm:p-6',
  emphasis: 'p-4 sm:p-6',
  plain: '',
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * `<summary>` accepts phrasing and heading content only, so the description renders as a
 * `<span>` block rather than a `<p>` and stays valid in both the plain and disclosure forms.
 */
function SectionHeading({
  title,
  description,
  icon: Icon,
  headingLevel: Heading,
  headingId,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  headingLevel: 'h2' | 'h3' | 'h4';
  headingId: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />}
      <div className="min-w-0">
        <Heading id={headingId} className="text-base font-semibold tracking-tight text-foreground">
          {title}
        </Heading>
        {description && (
          <span className="mt-1 block max-w-[72ch] text-sm leading-relaxed text-muted-foreground">
            {description}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Groups related project-detail operations beneath one stable in-page destination.
 * Macro groups use whitespace and a rule rather than another heavy nested card.
 */
export function ProjectDetailMacroSection({
  id,
  title,
  description,
  children,
  className,
}: ProjectDetailMacroSectionProps) {
  const headingId = `${id}-heading`;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn('scroll-mt-44 xl:scroll-mt-40', className)}
      data-slot="project-detail-macro-section"
    >
      <div className="border-b border-border pb-4">
        <h2 id={headingId} className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="mt-1.5 max-w-[75ch] text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </section>
  );
}

export function ProjectReviewSection({
  title,
  description,
  icon,
  action,
  children,
  className,
  tone = 'surface',
  headingLevel = 'h3',
  id,
  collapsible = false,
  defaultOpen = false,
  collapsedHint,
}: ProjectReviewSectionProps) {
  const headingId = `${id ?? slugify(title)}-heading`;

  if (collapsible) {
    return (
      <details
        open={defaultOpen}
        id={id}
        className={cn('group scroll-mt-44 xl:scroll-mt-40', TONE_CONTAINER[tone], className)}
        data-slot="project-review-section"
      >
        <summary
          className={cn(
            'flex min-h-[44px] cursor-pointer list-none items-start justify-between gap-4 rounded-xl',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            TONE_PADDING[tone] || 'py-2'
          )}
        >
          <SectionHeading
            title={title}
            description={description}
            icon={icon}
            headingLevel={headingLevel}
            headingId={headingId}
          />
          <span className="flex shrink-0 items-center gap-2 pt-0.5 text-sm font-medium text-foreground-subtle">
            {collapsedHint && <span>{collapsedHint}</span>}
            <ChevronRight
              className="h-4 w-4 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div
          className={cn(
            tone === 'plain'
              ? 'pt-4'
              : 'border-t border-border px-4 pb-4 pt-4 sm:px-6 sm:pb-6 sm:pt-6'
          )}
        >
          {children}
        </div>
      </details>
    );
  }

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn('scroll-mt-44 xl:scroll-mt-40', TONE_CONTAINER[tone], TONE_PADDING[tone], className)}
      data-slot="project-review-section"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <SectionHeading
          title={title}
          description={description}
          icon={icon}
          headingLevel={headingLevel}
          headingId={headingId}
        />
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={cn(tone === 'plain' ? 'mt-4' : 'mt-5')}>{children}</div>
    </section>
  );
}
