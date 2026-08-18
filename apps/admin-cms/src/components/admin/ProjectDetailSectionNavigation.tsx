export const PROJECT_DETAIL_SECTION_LINKS = [
  { id: 'review-and-edit', label: 'Review and edit' },
  { id: 'content-and-media', label: 'Content and media' },
  { id: 'participant-and-publication', label: 'Participant and publication' },
  { id: 'technical-and-history', label: 'Technical details and history' },
] as const;

/** Native fragment navigation: no router transition, scroll state, or client JavaScript. */
export function ProjectDetailSectionNavigation() {
  return (
    <nav
      aria-labelledby="project-detail-section-navigation-heading"
      className="rounded-xl border border-border/80 bg-background p-3 shadow-xs sm:p-4 xl:sticky xl:top-20 xl:z-30"
    >
      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center">
        <p
          id="project-detail-section-navigation-heading"
          className="shrink-0 text-sm font-semibold text-foreground"
        >
          On this page
        </p>
        <ul className="grid min-w-0 grid-cols-1 gap-2 min-[480px]:grid-cols-2 sm:flex sm:flex-wrap">
          {PROJECT_DETAIL_SECTION_LINKS.map((section) => (
            <li key={section.id} className="min-w-0">
              <a
                href={`#${section.id}`}
                className="inline-flex min-h-10 w-full items-center rounded-md border border-border bg-card px-3 py-2 text-sm font-medium leading-snug text-foreground-subtle transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
