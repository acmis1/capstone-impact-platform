import { ParticipantPreviewConfirmationStatus, ParticipantPreviewMediaViewRef, ParticipantPreviewSnapshot } from '../domain/participantPreview';

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * Only absolute http(s) URLs may become clickable participant-facing anchors. HTML-escaping a
 * URL string does not make it safe to place in an href — javascript:/data:/file: and other
 * schemes still execute or resolve as such regardless of escaping, so the scheme itself must be
 * allow-listed before the value is ever used as a link target.
 */
export function isSafeExternalPreviewUrl(url: string): boolean {
  if (typeof url !== 'string' || url.trim() === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return SAFE_EXTERNAL_URL_SCHEMES.has(parsed.protocol);
}

function renderList(items: string[]): string {
  if (items.length === 0) return '<p class="muted">None listed.</p>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderParagraph(label: string, value: string | null): string {
  if (!value || value.trim() === '') return '';
  return `<div class="field"><h3>${escapeHtml(label)}</h3><p>${escapeHtml(value).replace(/\n/g, '<br/>')}</p></div>`;
}

function renderExternalLinks(links: ParticipantPreviewSnapshot['externalLinks']): string {
  if (!links || links.length === 0) return '<p class="muted">None listed.</p>';
  return `<ul>${links
    .map((link) => {
      const url = typeof link.url === 'string' ? link.url : '';
      const label = link.label && link.label.trim() !== '' ? link.label : url;
      if (!isSafeExternalPreviewUrl(url)) {
        return `<li>${escapeHtml(label)}</li>`;
      }
      return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(label)}</a></li>`;
    })
    .join('')}</ul>`;
}

function renderMedia(media: ParticipantPreviewMediaViewRef[]): string {
  const withUrl = media.filter((m) => m.signedUrl);
  if (withUrl.length === 0) return '';

  const images = withUrl.filter((m) => m.assetType === 'poster_image' || m.assetType === 'snapshot_image');
  const documents = withUrl.filter((m) => m.assetType !== 'poster_image' && m.assetType !== 'snapshot_image');

  const imagesHtml = images
    .map((m) => `<img src="${escapeHtml(m.signedUrl as string)}" alt="${escapeHtml(m.fileName)}" loading="lazy" />`)
    .join('');
  const documentsHtml = documents
    .map(
      (m) =>
        `<a class="doc-link" href="${escapeHtml(m.signedUrl as string)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(m.fileName)}</a>`
    )
    .join('');

  return `
    <div class="field">
      <h3>Project Media</h3>
      ${imagesHtml ? `<div class="gallery">${imagesHtml}</div>` : ''}
      ${documentsHtml ? `<div class="documents">${documentsHtml}</div>` : ''}
    </div>
  `;
}

/**
 * Explicit participant confirmation of this exact preview version. A plain same-origin POST
 * form (no client-side JavaScript) — the token embedded in the current URL remains the sole
 * authorization capability, so the form intentionally carries no hidden project/preview data.
 * Once confirmed, the action is replaced with the recorded server-generated timestamp; a page
 * refresh renders the same confirmed state rather than the form, so it can never resubmit.
 */
function renderConfirmationSection(confirmation: ParticipantPreviewConfirmationStatus | null): string {
  if (confirmation) {
    const confirmedAtDisplay = escapeHtml(new Date(confirmation.confirmedAt).toUTCString());
    return `
    <div class="field confirmation confirmation-done">
      <h3>Confirmation</h3>
      <p>You confirmed that the project information shown in this exact preview is correct, on ${confirmedAtDisplay}.</p>
    </div>`;
  }

  return `
    <div class="field confirmation">
      <h3>Confirmation</h3>
      <p>If the project information shown above is correct, you may confirm it. Confirmation applies only to this exact preview as currently shown.</p>
      <form method="POST">
        <button type="submit" class="confirm-button">Confirm project details</button>
      </form>
    </div>`;
}

const PAGE_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0B0F19; color: #F3F4F6; font-family: Inter, system-ui, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  .banner { background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.25); border-radius: 10px; padding: 0.9rem 1.25rem; margin-bottom: 1.75rem; font-size: 0.85rem; color: #93C5FD; }
  h1 { font-size: 1.75rem; margin: 0 0 0.35rem 0; }
  .meta { color: #9CA3AF; font-size: 0.9rem; margin-bottom: 2rem; }
  .field { margin-bottom: 1.5rem; }
  .field h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9CA3AF; margin: 0 0 0.4rem 0; }
  .field p { margin: 0; line-height: 1.6; color: #E5E7EB; }
  .muted { color: #6B7280; font-style: italic; margin: 0; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; margin-top: 0.5rem; }
  .gallery img { width: 100%; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); }
  .documents { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .doc-link { color: #60A5FA; text-decoration: none; font-weight: 600; font-size: 0.9rem; }
  .doc-link:hover { text-decoration: underline; }
  .unavailable { text-align: center; padding: 4rem 1.5rem; }
  .confirmation { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 1.5rem; margin-top: 2rem; }
  .confirmation p { color: #D1D5DB; }
  .confirm-button { background: #3B82F6; color: #FFFFFF; border: none; padding: 0.65rem 1.35rem; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 0.9rem; }
  .confirm-button:hover { background: #2563EB; }
  .confirmation-done p { color: #10B981; font-weight: 600; }
`;

export function renderParticipantPreviewPage(params: {
  snapshot: ParticipantPreviewSnapshot;
  media: ParticipantPreviewMediaViewRef[];
  confirmation: ParticipantPreviewConfirmationStatus | null;
}): string {
  const { snapshot, media, confirmation } = params;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow, noarchive" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(snapshot.title)} — Participant Preview</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="banner">This is a private preview link prepared for your project team. It is not publicly listed or searchable.</div>
  <h1>${escapeHtml(snapshot.title)}</h1>
  <div class="meta">${escapeHtml(String(snapshot.year))}${snapshot.program ? ` &middot; ${escapeHtml(snapshot.program)}` : ''}${snapshot.discipline ? ` &middot; ${escapeHtml(snapshot.discipline)}` : ''}</div>

  ${renderParagraph('Summary', snapshot.summary)}
  ${renderParagraph('Background', snapshot.background)}
  ${renderParagraph('Solution', snapshot.solution)}
  ${renderParagraph('Accessibility Description', snapshot.accessibilityText)}

  ${renderMedia(media)}

  <div class="field">
    <h3>Disciplines</h3>
    ${renderList(snapshot.disciplines)}
  </div>
  <div class="field">
    <h3>Industry Categories</h3>
    ${renderList(snapshot.industryCategories)}
  </div>
  ${renderParagraph('Industry Partner', snapshot.industryPartner)}
  ${renderParagraph('Academic Supervisor', snapshot.academicSupervisor)}
  ${renderParagraph('Group Name', snapshot.groupName)}
  <div class="field">
    <h3>Team Members</h3>
    ${renderList(snapshot.teamMembers)}
  </div>
  <div class="field">
    <h3>Citations</h3>
    ${renderList(snapshot.citations)}
  </div>
  <div class="field">
    <h3>External Links</h3>
    ${renderExternalLinks(snapshot.externalLinks)}
  </div>

  ${renderConfirmationSection(confirmation)}
</div>
</body>
</html>`;
}

export function renderParticipantPreviewUnavailablePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow, noarchive" />
<meta name="referrer" content="no-referrer" />
<title>Preview Unavailable</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="wrap unavailable">
  <h1>Preview Unavailable</h1>
  <p class="muted">This preview link is invalid, expired, or has been revoked. Please contact your project coordinator for a current link.</p>
</div>
</body>
</html>`;
}
