import { escapeHtml } from './participantPreviewHtml';

export interface CorrectionFormState {
  submitted: boolean;
  canSubmit: boolean;
  error?: { field: string; message: string };
}

/** Plain same-origin form. No token, storage identity, script or third-party resource in markup. */
export function renderParticipantCorrectionForm(state: CorrectionFormState): string {
  const error = state.error;
  const inputs = [
    { name: 'workbook', label: 'Project details workbook', accept: '.xlsx', hint: 'Required: project-details.xlsx, up to 5 MB. One project row; include poster text and descriptions for every supporting image.', required: true },
    { name: 'poster', label: 'Poster image', accept: '.png,.jpg,.jpeg,.webp', hint: 'Required: PNG, JPEG or WebP, up to 5 MB.', required: true },
    { name: 'pdf', label: 'Poster PDF', accept: '.pdf', hint: 'Required: PDF, up to 20 MB.', required: true },
    ...Array.from({ length: 10 }, (_, i) => ({ name: `snapshot${i + 1}`, label: `Supporting image ${i + 1}`, accept: '.png,.jpg,.jpeg,.webp', hint: `Optional: PNG, JPEG or WebP, up to 5 MB. Use the description for snapshot ${i + 1} in your workbook.`, required: false })),
  ];
  return `<section class="correction-package" id="correction-package" aria-labelledby="correction-package-heading">
    <h2 id="correction-package-heading">Submit corrected project package</h2>
    <p>The project team owns these files. Correct your source workbook and media, then upload the complete replacement package for staff review. Maximum 32 MB in total.</p>
    ${state.submitted && !error ? '<p role="status" tabindex="-1" autofocus>Corrected package submitted for staff review. The current project has not changed.</p>' : ''}
    ${error ? `<div id="package-error" role="alert" tabindex="-1" autofocus><h3>Check your corrected package</h3><p>${escapeHtml(error.message)}</p><p>Select your files again before submitting.</p></div>` : ''}
    ${state.canSubmit ? `<p>You may submit up to three distinct packages for this correction request. A newer completed package replaces your earlier candidate until staff begins review. Starting staff review closes uploads.</p>
    <form method="POST" enctype="multipart/form-data" aria-label="Corrected project package">
      ${inputs.map((input) => `<div class="correction-file-field">
        <label for="correction-${input.name}">${input.label}</label>
        <p id="${input.name}-hint" class="form-hint">${input.hint}</p>
        <input id="correction-${input.name}" name="${input.name}" type="file" accept="${input.accept}" ${input.required ? 'required' : ''} aria-describedby="${input.name}-hint${error && (error.field === input.name || error.field === 'package') ? ' package-error' : ''}" ${error?.field === input.name ? 'aria-invalid="true"' : ''} />
      </div>`).join('')}
      <button type="submit" class="correction-button">Submit corrected package for staff review</button>
      <p>Keep this page open while the files upload. Your saved source files remain on your device.</p>
    </form>` : '<p>No further distinct packages can be submitted in this correction cycle. Contact your project coordinator for help.</p>'}
  </section>`;
}
