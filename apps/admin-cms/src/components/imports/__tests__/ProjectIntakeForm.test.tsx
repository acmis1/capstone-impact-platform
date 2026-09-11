// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectIntakeForm } from '../ProjectIntakeForm';
import * as clientMaterializer from '../../../import/formIntakeMaterializerClient';

describe('ProjectIntakeForm Component', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders all primary form sections and input controls including MG-05 gallery fields', () => {
    render(<ProjectIntakeForm onPackageReady={vi.fn()} />);

    expect(screen.getByText(/1\. Project Identification/i)).toBeTruthy();
    expect(screen.getByText(/2\. Core Project Information/i)).toBeTruthy();
    expect(screen.getByText(/3\. Academic & Industry Details/i)).toBeTruthy();
    expect(screen.getByText(/4\. Showcase & Layout Preferences/i)).toBeTruthy();
    expect(screen.getByText(/5\. External Links/i)).toBeTruthy();
    expect(screen.getByText(/6\. Accessible Poster Content/i)).toBeTruthy();
    expect(screen.getByText(/7\. Required Poster Media/i)).toBeTruthy();
    expect(screen.getByText(/8\. Snapshot Gallery/i)).toBeTruthy();

    expect(screen.getByLabelText(/Project Identifier \(Public ID\)/i)).toBeTruthy();
    expect(screen.getByLabelText(/Project Title/i)).toBeTruthy();
    expect(screen.getByLabelText(/Short Public Summary/i)).toBeTruthy();
    expect(screen.getByLabelText(/Study Program/i)).toBeTruthy();
    expect(screen.getByLabelText(/Primary Discipline/i)).toBeTruthy();
    expect(screen.getByLabelText(/Project Year/i)).toBeTruthy();
    expect(screen.getByLabelText(/Group Name/i)).toBeTruthy();
    expect(screen.getByLabelText(/Team Members/i)).toBeTruthy();
    expect(screen.getByLabelText(/Poster Full Text/i)).toBeTruthy();
    expect(screen.getByLabelText(/Accessibility Description \(Alt text\)/i)).toBeTruthy();
    expect(screen.getByLabelText(/Poster Image \(poster\.png\)/i)).toBeTruthy();
    expect(screen.getByLabelText(/Poster PDF \(poster\.pdf\)/i)).toBeTruthy();

    // MG-05 gallery slot 1 controls
    expect(screen.getByLabelText(/Snapshot 1 alt text/i)).toBeTruthy();
    expect(screen.getByLabelText(/Content classification/i)).toBeTruthy();
    expect(screen.getByLabelText(/Full textual equivalent/i)).toBeTruthy();

    expect(screen.getByRole('button', { name: /Check project and continue/i })).toBeTruthy();
  });

  it('validates required fields and displays error summary', async () => {
    render(<ProjectIntakeForm onPackageReady={vi.fn()} />);

    // Clear prefilled year to test year validation too
    fireEvent.change(screen.getByLabelText(/Project Year/i), { target: { value: '' } });

    const submitBtn = screen.getByRole('button', { name: /Check project and continue/i });
    fireEvent.click(submitBtn);

    expect(
      await screen.findByText(/Please resolve \d+ form error\(s\) before continuing/i)
    ).toBeTruthy();

    // Individual field error alerts appear in summary and inline
    expect(screen.getAllByText('Project identifier is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Project title is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Short public summary is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Project year is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Study program is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Primary discipline is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Group name is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('At least one team member is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Poster full text is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Accessibility description is required.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Required poster image (PNG, JPEG, or WEBP) is missing.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Required poster PDF is missing.').length).toBeGreaterThanOrEqual(1);
  });

  it('allows incrementing visible snapshot slots', () => {
    render(<ProjectIntakeForm onPackageReady={vi.fn()} />);

    // Starts with 1 snapshot slot
    const addSnap2 = screen.getByRole('button', { name: /Add snapshot 2/i });
    expect(addSnap2).toBeTruthy();

    fireEvent.click(addSnap2);
    const addSnap3 = screen.getByRole('button', { name: /Add snapshot 3/i });
    expect(addSnap3).toBeTruthy();

    fireEvent.click(addSnap3);
    const addSnap4 = screen.getByRole('button', { name: /Add snapshot 4/i });
    expect(addSnap4).toBeTruthy();
  });

  it('handles MG-05 gallery classification selection', () => {
    render(<ProjectIntakeForm onPackageReady={vi.fn()} />);

    const selectEl = screen.getByLabelText(/Content classification/i) as HTMLSelectElement;
    const fullTextEl = screen.getByLabelText(/Full textual equivalent/i) as HTMLTextAreaElement;

    // Initially disabled when no classification selected
    expect(fullTextEl.disabled).toBe(true);

    // Select text_bearing
    fireEvent.change(selectEl, { target: { value: 'text_bearing' } });
    expect(fullTextEl.disabled).toBe(false);

    // Select ordinary
    fireEvent.change(selectEl, { target: { value: 'ordinary' } });
    expect(fullTextEl.disabled).toBe(true);
  });

  it('submits valid form data, materializes package, and invokes onPackageReady', async () => {
    const onPackageReady = vi.fn();
    const fakeFiles = [
      new File(['xlsx'], 'project-details.xlsx'),
      new File(['png'], 'poster.png'),
      new File(['pdf'], 'poster.pdf'),
    ];

    vi.spyOn(clientMaterializer, 'materializeFormIntakePackage').mockResolvedValue({
      success: true,
      package: {
        files: fakeFiles,
        selectedRootName: 'smart-solar-iot',
        totalBytes: 3000,
      },
    });

    render(<ProjectIntakeForm onPackageReady={onPackageReady} />);

    // Fill required fields
    fireEvent.change(screen.getByLabelText(/Project Identifier \(Public ID\)/i), { target: { value: 'smart-solar-iot' } });
    fireEvent.change(screen.getByLabelText(/Project Title/i), { target: { value: 'Smart Solar IoT Telemetry' } });
    fireEvent.change(screen.getByLabelText(/Short Public Summary/i), { target: { value: 'A distributed telemetry system.' } });
    fireEvent.change(screen.getByLabelText(/Study Program/i), { target: { value: 'Bachelor of Computer Science' } });
    fireEvent.change(screen.getByLabelText(/Primary Discipline/i), { target: { value: 'Cloud Computing' } });
    fireEvent.change(screen.getByLabelText(/Group Name/i), { target: { value: 'Solar Devs' } });
    fireEvent.change(screen.getByLabelText(/Team Members/i), { target: { value: 'Alice Smith, Bob Jones' } });
    fireEvent.change(screen.getByLabelText(/Poster Full Text/i), { target: { value: 'Full solar transcript content.' } });
    fireEvent.change(screen.getByLabelText(/Accessibility Description \(Alt text\)/i), { target: { value: 'Poster illustrating solar panel sensors.' } });

    // Upload poster files
    const posterImg = new File(['fake-png'], 'poster.png', { type: 'image/png' });
    const posterPdf = new File(['fake-pdf'], 'poster.pdf', { type: 'application/pdf' });

    fireEvent.change(screen.getByLabelText(/Poster Image \(poster\.png\)/i), { target: { files: [posterImg] } });
    fireEvent.change(screen.getByLabelText(/Poster PDF \(poster\.pdf\)/i), { target: { files: [posterPdf] } });

    const submitBtn = screen.getByRole('button', { name: /Check project and continue/i });
    fireEvent.click(submitBtn);

    await screen.findByRole('button', { name: /Check project and continue/i });
    expect(clientMaterializer.materializeFormIntakePackage).toHaveBeenCalledTimes(1);
    expect(onPackageReady).toHaveBeenCalledWith({
      files: fakeFiles,
      selectedRootName: 'smart-solar-iot',
      totalBytes: 3000,
    });
  });
});
