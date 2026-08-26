// @vitest-environment jsdom

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Layers } from 'lucide-react';
import { ProjectDetailMacroSection, ProjectReviewSection } from './ProjectReviewSection';
import { ProjectDetailSectionNavigation, PROJECT_DETAIL_SECTION_LINKS } from './ProjectDetailSectionNavigation';
import { ProjectAuditHistory } from './ProjectAuditHistory';
import {
  GuardedProjectBackLink,
  ProjectMetadataNavigationProvider,
  useProjectMetadataNavigation,
} from './ProjectMetadataNavigation';
import type { AuditHistoryView } from '../../projects/projectDetailAuxiliaryData';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProjectReviewSection layout primitive', () => {
  it('renders a semantic section labelled by its own heading', () => {
    render(
      <ProjectReviewSection id="overview" title="Project overview" description="Academic identification">
        <p>Body</p>
      </ProjectReviewSection>
    );

    const heading = screen.getByRole('heading', { name: 'Project overview', level: 3 });
    expect(heading).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Project overview' });
    expect(within(region).getByText('Academic identification')).toBeTruthy();
    expect(within(region).getByText('Body')).toBeTruthy();
  });

  it('honours an explicit heading level', () => {
    render(
      <ProjectReviewSection title="Change history" headingLevel="h2">
        <p>Body</p>
      </ProjectReviewSection>
    );

    expect(screen.getByRole('heading', { name: 'Change history', level: 2 })).toBeTruthy();
  });

  it('renders the action slot alongside the heading', () => {
    render(
      <ProjectReviewSection title="Media" action={<button type="button">Edit media</button>}>
        <p>Body</p>
      </ProjectReviewSection>
    );

    expect(screen.getByRole('button', { name: 'Edit media' })).toBeTruthy();
  });

  it('drops the container surface for the plain tone while keeping the heading', () => {
    const { container } = render(
      <ProjectReviewSection title="Change history" tone="plain">
        <p>Body</p>
      </ProjectReviewSection>
    );

    const section = container.querySelector('[data-slot="project-review-section"]');
    expect(section?.className).not.toMatch(/bg-card/);
    expect(screen.getByRole('heading', { name: 'Change history' })).toBeTruthy();
  });

  it('gives the emphasis tone a stronger container than an ordinary section', () => {
    const { container: plainContainer } = render(
      <ProjectReviewSection title="Ordinary">
        <p>Body</p>
      </ProjectReviewSection>
    );
    const ordinary = plainContainer.querySelector('[data-slot="project-review-section"]')!.className;
    cleanup();

    const { container: emphasisContainer } = render(
      <ProjectReviewSection title="Decision" tone="emphasis">
        <p>Body</p>
      </ProjectReviewSection>
    );
    const emphasis = emphasisContainer.querySelector('[data-slot="project-review-section"]')!.className;

    expect(ordinary).not.toBe(emphasis);
    expect(ordinary).toMatch(/border-border-structural/);
    expect(emphasis).toMatch(/border-border-structural/);
    expect(emphasis).toMatch(/shadow-sm/);
  });

  describe('native disclosure form', () => {
    it('starts collapsed and exposes native expanded state, keeping content reachable', () => {
      const { container } = render(
        <ProjectReviewSection title="Technical details" icon={Layers} collapsible>
          <p>Cached validation counts</p>
        </ProjectReviewSection>
      );

      const details = container.querySelector('details') as HTMLDetailsElement;
      expect(details).toBeTruthy();
      expect(details.open).toBe(false);
      // The heading stays in the document outline while collapsed, so the section is discoverable.
      expect(screen.getByRole('heading', { name: 'Technical details' })).toBeTruthy();
      // Content remains in the accessibility tree and is revealed by the native control.
      expect(screen.getByText('Cached validation counts')).toBeTruthy();

      const summary = container.querySelector('summary') as HTMLElement;
      fireEvent.click(summary);
      details.open = true;
      expect(details.open).toBe(true);
    });

    it('can start expanded when the state makes the content immediately relevant', () => {
      const { container } = render(
        <ProjectReviewSection title="Technical details" collapsible defaultOpen>
          <p>Archive evidence</p>
        </ProjectReviewSection>
      );

      expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(true);
      expect(screen.getByText('Archive evidence')).toBeTruthy();
    });

    it('renders a collapsed hint next to the disclosure control', () => {
      render(
        <ProjectReviewSection title="Participant confirmation" collapsible collapsedHint="After approval">
          <p>Panel</p>
        </ProjectReviewSection>
      );

      expect(screen.getByText('After approval')).toBeTruthy();
    });
  });
});

describe('Project Detail macro navigation', () => {
  it('labels one native anchor navigation and targets four semantic macro sections', () => {
    render(
      <>
        <ProjectDetailSectionNavigation />
        {PROJECT_DETAIL_SECTION_LINKS.map((section) => (
          <ProjectDetailMacroSection
            key={section.id}
            id={section.id}
            title={section.label}
            description={`${section.label} description`}
          >
            <ProjectReviewSection title={`${section.label} child`}>
              <p>Child content</p>
            </ProjectReviewSection>
          </ProjectDetailMacroSection>
        ))}
      </>
    );

    const navigation = screen.getByRole('navigation', { name: 'On this page' });
    expect(navigation.className).toContain('sticky');
    expect(navigation.className).toContain('border-border-structural');
    expect(navigation.className).toContain('bg-card');
    expect(navigation.className).toContain('top-16');
    expect(navigation.className).toContain('xl:top-20');
    const linkRow = navigation.querySelector('ul') as HTMLUListElement;
    expect(linkRow.className).toContain('overflow-x-auto');
    expect(linkRow.className).toContain('xl:overflow-visible');
    for (const section of PROJECT_DETAIL_SECTION_LINKS) {
      const link = within(navigation).getByRole('link', { name: section.label });
      expect(link.getAttribute('href')).toBe(`#${section.id}`);
      expect(link.className).toContain('whitespace-nowrap');
      expect(link.className).toContain('border-border');
      expect(document.getElementById(section.id)).toBeTruthy();
      expect(document.getElementById(section.id)?.className).toContain('scroll-mt-44');
      expect(screen.getByRole('heading', { name: section.label, level: 2 })).toBeTruthy();
      expect(screen.getByRole('heading', { name: `${section.label} child`, level: 3 })).toBeTruthy();
    }
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('keeps same-page anchors outside the dirty-navigation guard while Back remains guarded', () => {
    function DirtyStateControl() {
      const { setDirty } = useProjectMetadataNavigation();
      return <button type="button" onClick={() => setDirty(true)}>Mark project information dirty</button>;
    }

    const confirmDiscard = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <ProjectMetadataNavigationProvider>
        <ProjectDetailSectionNavigation />
        <DirtyStateControl />
        <GuardedProjectBackLink href="/admin">Back to projects</GuardedProjectBackLink>
      </ProjectMetadataNavigationProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark project information dirty' }));
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('link', { name: 'Content and media' }));
    expect(confirmDiscard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('link', { name: 'Back to projects' }));
    expect(confirmDiscard).toHaveBeenCalledTimes(1);
  });
});

const auditRecord: AuditHistoryView = {
  id: 'a0000000-0000-4000-8000-000000000001',
  action: 'approve',
  timestamp: '2026-08-01T10:00:00.000Z',
  fromStatus: 'in_review',
  toStatus: 'approved',
  comments: 'Poster and accessibility text verified against the submitted package.',
  actorFullName: 'Local Reviewer',
  actorEmail: 'local.reviewer@capstone.test',
  metadataEventDetails: null,
  mediaAccessibilityEventDetails: null,
};

function auditRecords(count: number): AuditHistoryView[] {
  return Array.from({ length: count }, (_, index) => ({
    ...auditRecord,
    id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    timestamp: `2026-08-${String(10 - index).padStart(2, '0')}T10:00:00.000Z`,
    comments: `Ordered audit comment ${index + 1}`,
    actorFullName: `Audit actor ${index + 1}`,
    actorEmail: `audit.actor.${index + 1}@capstone.test`,
  }));
}

describe('ProjectAuditHistory', () => {
  it('states unavailability without erasing the rest of the page', () => {
    render(<ProjectAuditHistory auditRecords={null} />);
    expect(screen.getByRole('status').textContent).toMatch(/temporarily unavailable/i);
  });

  it('distinguishes a genuinely empty history from an unavailable one', () => {
    render(<ProjectAuditHistory auditRecords={[]} />);
    expect(screen.getByText(/No recorded changes for this project yet/i)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows one to three records in full without an unnecessary history disclosure', () => {
    const { container } = render(<ProjectAuditHistory auditRecords={auditRecords(3)} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('list', { name: 'Recorded changes' })).toBeTruthy();
    expect(screen.queryByText(/older changes/i)).toBeNull();
    expect(container.querySelector('details')).toBeNull();
  });

  it('previews the latest three and keeps every older record once in a native disclosure', () => {
    const records = auditRecords(6);
    const { container } = render(<ProjectAuditHistory auditRecords={records} />);

    const recent = screen.getByRole('list', { name: 'Most recent changes' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Showing the 3 most recent of 6 recorded changes.')).toBeTruthy();

    const details = container.querySelector('details') as HTMLDetailsElement;
    const older = container.querySelector('ol[aria-label="Older changes"]') as HTMLOListElement;
    expect(details.open).toBe(false);
    expect(older.start).toBe(4);
    expect(older.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('Show 3 older changes')).toBeTruthy();

    for (const record of records) {
      expect(screen.getAllByText(record.actorFullName)).toHaveLength(1);
      expect(screen.getAllByText(record.comments!)).toHaveLength(1);
    }

    const actorsInDocumentOrder = [...container.querySelectorAll('li')].map((entry) =>
      entry.textContent?.match(/Audit actor \d/)?.[0]
    );
    expect(actorsInDocumentOrder).toEqual(records.map((record) => record.actorFullName));

    fireEvent.click(screen.getByText('Show 3 older changes'));
    expect(details.open).toBe(true);
    expect(screen.getByText('Hide 3 older changes').className).toContain('group-open:inline');
    expect(screen.queryByText('Collapse')).toBeNull();
  });

  it('keeps older actor evidence in server-rendered markup while visually collapsed', () => {
    const markup = renderToStaticMarkup(<ProjectAuditHistory auditRecords={auditRecords(5)} />);

    expect(markup).toContain('Show 2 older changes');
    expect(markup).toContain('Hide 2 older changes');
    expect(markup).toContain('Audit actor 5');
    expect(markup.match(/Audit actor 5/g)).toHaveLength(1);
  });

  it('preserves timestamp, action, actor, transition and comment evidence', () => {
    render(<ProjectAuditHistory auditRecords={[auditRecord]} />);

    const entry = within(screen.getByRole('listitem'));
    // The action label, plus the destination status of the recorded transition.
    expect(entry.getAllByText('Approved')).toHaveLength(2);
    expect(entry.getByText('In review')).toBeTruthy();
    expect(entry.getByText(/Local Reviewer/)).toBeTruthy();
    expect(entry.getByText(/local\.reviewer@capstone\.test/)).toBeTruthy();
    expect(entry.getByText(/Poster and accessibility text verified/)).toBeTruthy();
    // The recorded time is rendered as a machine-readable time element.
    expect(entry.getByRole('time')).toBeTruthy();
    // Transition endpoints render as readable labels, not raw enum values.
    expect(screen.queryByText('in_review')).toBeNull();
  });

  it('keeps metadata change evidence behind an accessible disclosure without losing values', () => {
    const { container } = render(
      <ProjectAuditHistory
        auditRecords={[{
          ...auditRecord,
          action: 'update_metadata',
          fromStatus: null,
          toStatus: null,
          comments: null,
          metadataEventDetails: {
            version: 1,
            type: 'project_metadata',
            changedFields: ['title'],
            before: { title: 'Old title' },
            after: { title: 'New title' },
          },
        }]}
      />
    );

    expect(screen.getByText('Project information updated')).toBeTruthy();
    expect(screen.getByText(/Changed fields:/)).toBeTruthy();
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(screen.getByText('Old title')).toBeTruthy();
    expect(screen.getByText('New title')).toBeTruthy();
  });

  it('preserves snapshot alt-text change evidence including a previously absent value', () => {
    render(
      <ProjectAuditHistory
        auditRecords={[{
          ...auditRecord,
          action: 'update_metadata',
          fromStatus: null,
          toStatus: null,
          comments: null,
          mediaAccessibilityEventDetails: {
            version: 1,
            type: 'media_accessibility',
            mediaAssetId: 'b0000000-0000-4000-8000-000000000001',
            assetType: 'snapshot_image',
            changedFields: ['snapshotAltText'],
            before: { snapshotAltText: null },
            after: { snapshotAltText: 'Dashboard comparing queue lengths.' },
          },
        }]}
      />
    );

    expect(screen.getByText(/Snapshot image alt text/)).toBeTruthy();
    expect(screen.getByText('Not previously provided')).toBeTruthy();
    expect(screen.getByText('Dashboard comparing queue lengths.')).toBeTruthy();
  });

  it('renders history as a reflowing list rather than a table with hideable columns', () => {
    const { container } = render(<ProjectAuditHistory auditRecords={[auditRecord]} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('ol')).toBeTruthy();
  });
});

describe('project detail workspace information architecture', () => {
  const pageSource = fs.readFileSync(
    path.resolve(__dirname, '../../app/admin/projects/[publicId]/page.tsx'),
    'utf-8'
  );
  const navigationSource = fs.readFileSync(
    path.resolve(__dirname, './ProjectDetailSectionNavigation.tsx'),
    'utf-8'
  );
  const sectionSource = fs.readFileSync(
    path.resolve(__dirname, './ProjectReviewSection.tsx'),
    'utf-8'
  );
  const auditHistorySource = fs.readFileSync(
    path.resolve(__dirname, './ProjectAuditHistory.tsx'),
    'utf-8'
  );

  it('keeps four ordered macro destinations with the requested labels', () => {
    const macroSections = [
      ['review-and-edit', 'Review and edit'],
      ['content-and-media', 'Content and media'],
      ['participant-and-publication', 'Participant and publication'],
      ['technical-and-history', 'Technical details and history'],
    ] as const;
    let previousIndex = -1;
    for (const [id, title] of macroSections) {
      const index = pageSource.indexOf(`id="${id}"`);
      expect(index, `Missing macro section: ${id}`).toBeGreaterThan(previousIndex);
      expect(pageSource.slice(index, index + 250)).toContain(`title="${title}"`);
      previousIndex = index;
    }
  });

  it('uses static fragment navigation rather than tabs or a client scroll state machine', () => {
    expect(pageSource).toContain('<ProjectDetailSectionNavigation />');
    expect(navigationSource).not.toContain("'use client'");
    expect(navigationSource).not.toMatch(/useState|useEffect|onClick|role="tab"/);
    for (const [id, label] of [
      ['review-and-edit', 'Review and edit'],
      ['content-and-media', 'Content and media'],
      ['participant-and-publication', 'Participant and publication'],
      ['technical-and-history', 'Technical details and history'],
    ]) {
      expect(navigationSource).toContain(`{ id: '${id}', label: '${label}' }`);
      expect(pageSource).toContain(`id="${id}"`);
    }
  });

  it('keeps the one fragment navigation sticky with locally scrollable compact links', () => {
    expect(navigationSource).toContain('sticky top-16 z-30');
    expect(navigationSource).toContain('xl:top-20');
    expect(navigationSource).toContain('overflow-x-auto');
    expect(navigationSource).toContain('overscroll-x-contain');
    expect(navigationSource).toContain('xl:overflow-visible');
    expect(navigationSource).toContain('whitespace-nowrap');
    expect(navigationSource).not.toContain('grid-cols-1');
  });

  it('clears the sticky navigation for every macro and child fragment target', () => {
    expect(sectionSource).toContain("'scroll-mt-44 xl:scroll-mt-40'");
    expect(sectionSource).not.toContain('scroll-mt-24');
    expect(pageSource).toContain('id="project-information" className="scroll-mt-44');
  });

  it('uses native details with CSS-only Show/Hide wording for older changes', () => {
    expect(auditHistorySource).toContain('<details');
    expect(auditHistorySource).toContain('Show {olderRecords.length} older changes');
    expect(auditHistorySource).toContain('Hide {olderRecords.length} older changes');
    expect(auditHistorySource).toContain('group-open:hidden');
    expect(auditHistorySource).toContain('group-open:inline');
    expect(auditHistorySource).not.toContain('Collapse');
    expect(auditHistorySource).not.toMatch(/useState|useEffect/);
  });

  it('keeps every high-priority workflow section on the page', () => {
    for (const sectionId of [
      'workflow-status',
      'project-information',
      'showcase-content',
      'media-accessibility',
      'participant-confirmation',
      'publication-lifecycle',
      'technical-details',
      'change-history',
    ]) {
      expect(pageSource, `Missing project-detail section: ${sectionId}`).toContain(`id="${sectionId}"`);
    }
  });

  it('groups child sections beneath the correct macro areas in workflow order', () => {
    const review = pageSource.slice(
      pageSource.indexOf('id="review-and-edit"'),
      pageSource.indexOf('id="content-and-media"'),
    );
    expect(review).toContain('id="workflow-status"');
    expect(review).toContain('id="project-information"');
    expect(review.indexOf('id="workflow-status"')).toBeLessThan(review.indexOf('id="project-information"'));

    const content = pageSource.slice(
      pageSource.indexOf('id="content-and-media"'),
      pageSource.indexOf('id="participant-and-publication"'),
    );
    expect(content).toContain('id="showcase-content"');
    expect(content).toContain('id="media-accessibility"');

    const lifecycle = pageSource.slice(
      pageSource.indexOf('id="participant-and-publication"'),
      pageSource.indexOf('id="technical-and-history"'),
    );
    expect(lifecycle).toContain('id="participant-confirmation"');
    expect(lifecycle).toContain('id="publication-lifecycle"');

    const technical = pageSource.slice(
      pageSource.indexOf('id="technical-and-history"'),
      pageSource.indexOf('<aside aria-label="Project record context"'),
    );
    expect(technical).toContain('id="technical-details"');
    expect(technical).toContain('id="change-history"');
  });

  it('renders each canonical mutation control exactly once, so no action can double-fire', () => {
    for (const control of ['<SubmitForReviewButton', '<StagingReviewActions', '<ProjectMetadataEditor', '<LocalArchivePanel', '<PublicationPreparationPanel']) {
      const occurrences = pageSource.split(control).length - 1;
      expect(occurrences, `${control} must be rendered exactly once`).toBe(1);
    }
  });

  it('keeps the validation summary in the same section as the workflow actions', () => {
    const decisionSection = pageSource.slice(
      pageSource.indexOf('id="workflow-status"'),
      pageSource.indexOf('id="showcase-content"')
    );
    expect(decisionSection).toContain('<ProjectValidationSummary');
    expect(decisionSection).toContain('<StagingReviewActions');
    expect(decisionSection).toContain('<SubmitForReviewButton');
  });

  it('passes only permission-filtered review actions to the decision controls and orientation', () => {
    expect(pageSource).toContain('const statusAllowedActions = getAllowedReviewActions(project.status);');
    expect(pageSource).toContain('getPermittedReviewActions(statusAllowedActions, adminContext?.permissions ?? [])');
    expect(pageSource).toContain('allowedActions: permittedReviewActions');
    expect(pageSource).toContain('allowedActions={permittedReviewActions}');
  });

  it('passes the already-derived page capabilities into capability-aware orientation', () => {
    for (const capability of [
      'canManageParticipantPreview: canManagePreview',
      'canResolveParticipantCorrection: canResolveCorrection',
      'canPreparePublication: canPreparePublicationPlan',
    ]) {
      expect(pageSource).toContain(capability);
    }
    expect(pageSource).toMatch(/canExecuteArchive: archiveExecutionTarget === 'local' \|\| archiveExecutionTarget === 'staging',\s*participantResponse:/);
  });

  it('shows a bounded unavailable archive state only for a declared staging runtime', () => {
    expect(pageSource).toContain("isStagingRuntimeEnvironment()\n              ? 'staging-unavailable'");
    expect(pageSource).toContain("? 'staging'\n            : isStagingRuntimeEnvironment()");
    expect(pageSource).not.toContain("archiveExecutionTarget = 'staging-unavailable'");
  });

  it('keeps technical details and change history available rather than removed', () => {
    expect(pageSource).toContain('<ProjectAuditHistory');
    expect(pageSource).toContain('Layout settings');
    expect(pageSource).toContain('System details');
    expect(pageSource).toContain('Pending showcase removal');
  });

  it('surfaces a pending showcase removal outside the collapsed technical section', () => {
    const beforeTechnical = pageSource.slice(0, pageSource.indexOf('id="technical-details"'));
    expect(beforeTechnical).toContain('project.pendingRemovalFromPublic &&');
    expect(beforeTechnical).toMatch(/Showcase removal pending/);
  });

  it('does not constrain the workspace to the previous narrow single column', () => {
    expect(pageSource).not.toContain('max-w-5xl');
    expect(pageSource).toContain('xl:grid-cols-[minmax(0,1fr)_340px]');
  });

  it('keeps the contextual rail secondary and non-sticky beside the macro workspace', () => {
    const asideSource = pageSource.slice(
      pageSource.indexOf('<aside aria-label="Project record context"'),
      pageSource.indexOf('</aside>'),
    );
    expect(asideSource).not.toContain('sticky');
    expect(asideSource).toContain('Project record');
    expect(asideSource).toContain('Import origin');
    expect(asideSource).toContain('Review staging sandbox');
  });

  it('keeps the unsaved-edit navigation guard on the back link', () => {
    expect(pageSource).toContain('<ProjectMetadataNavigationProvider>');
    expect(pageSource).toContain('<GuardedProjectBackLink');
  });

  it('does not truncate project identifiers', () => {
    const headerSource = pageSource.slice(pageSource.indexOf('<header'), pageSource.indexOf('</header>'));
    expect(headerSource).not.toContain('truncate');
    expect(headerSource).toContain('break-words');
  });

  it('leaves the participant-facing preview route out of this page', () => {
    expect(pageSource).not.toContain('participant-preview/');
    expect(pageSource).not.toMatch(/from '.*app\/participant-preview/);
  });
});
