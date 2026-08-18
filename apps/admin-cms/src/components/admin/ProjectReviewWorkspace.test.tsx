// @vitest-environment jsdom

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Layers } from 'lucide-react';
import { ProjectReviewSection } from './ProjectReviewSection';
import { ProjectAuditHistory } from './ProjectAuditHistory';
import type { AuditHistoryView } from '../../projects/projectDetailAuxiliaryData';

afterEach(cleanup);

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
    expect(emphasis).toMatch(/border-border-strong/);
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

  it('keeps every high-priority workflow section on the page', () => {
    for (const sectionId of [
      'workflow-status',
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
