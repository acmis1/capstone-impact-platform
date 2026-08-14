import { ParticipantPreviewMediaViewRef, ParticipantPreviewResponseState, ParticipantPreviewSnapshot } from '../domain/participantPreview';
import { MAX_CORRECTION_COMMENT_LENGTH } from './participantPreviewCorrectionComment';

/**
 * Raised when stored preview state cannot supply an authoritative text alternative for an image the
 * participant would otherwise be shown. The route turns this into the same generic unavailable
 * response as any other unresolvable preview.
 */
export class ParticipantPreviewMediaAccessibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParticipantPreviewMediaAccessibilityError';
  }
}

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

/**
 * The participant-facing alt attribute for one image, taken only from immutably snapshotted
 * accessibility evidence.
 *
 * A poster image uses the snapshotted project-level accessibilityText; a snapshot image uses its
 * own snapshotted altText. There is deliberately no fallback to the filename, the project title, or
 * a "Preview of ..." construction: those describe the file, not the image, and presenting one as a
 * text alternative would misrepresent an undescribed image as an accessible one.
 *
 * The workflow gates guarantee both values exist by the time a preview can be issued, so a missing
 * one means the stored preview state is malformed. Returning null makes the caller fail closed
 * rather than render a plausible-looking but false alt.
 */
function resolveParticipantImageAlt(
  media: ParticipantPreviewMediaViewRef,
  accessibilityText: string | null,
): string | null {
  const value = media.assetType === 'poster_image' ? accessibilityText : media.altText;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function renderMedia(media: ParticipantPreviewMediaViewRef[], accessibilityText: string | null): string {
  const withUrl = media.filter((m) => m.signedUrl);
  if (withUrl.length === 0) return '';

  const images = withUrl.filter((m) => m.assetType === 'poster_image' || m.assetType === 'snapshot_image');
  const documents = withUrl.filter((m) => m.assetType !== 'poster_image' && m.assetType !== 'snapshot_image');

  const imagesHtml = images
    .map((m) => {
      const altText = resolveParticipantImageAlt(m, accessibilityText);
      if (altText === null) {
        throw new ParticipantPreviewMediaAccessibilityError(
          'Participant preview media is missing its authoritative text alternative.',
        );
      }
      return `<img src="${escapeHtml(m.signedUrl as string)}" alt="${escapeHtml(altText)}" loading="lazy" />`;
    })
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
 * Explicit participant response to this exact preview version: either confirmation or a
 * correction request, mutually exclusive and both via a plain same-origin POST form (no
 * client-side JavaScript) — the token embedded in the current URL remains the sole authorization
 * capability, so neither form carries hidden project/preview data beyond the action
 * discriminator. Once a response is recorded, it is replaced with the recorded server-generated
 * outcome; a page refresh renders the same recorded state rather than either form, so it can
 * never resubmit.
 */
function renderResponseSection(responseState: ParticipantPreviewResponseState): string {
  if (responseState.type === 'confirmed') {
    const confirmedAtDisplay = escapeHtml(new Date(responseState.confirmedAt).toUTCString());
    return `
    <div class="field confirmation confirmation-done">
      <h3>Confirmation</h3>
      <p>You confirmed that the project information shown in this exact preview is correct, on ${confirmedAtDisplay}.</p>
    </div>`;
  }

  if (responseState.type === 'correction_requested') {
    const requestedAtDisplay = escapeHtml(new Date(responseState.requestedAt).toUTCString());
    const commentHtml = escapeHtml(responseState.comment).replace(/\n/g, '<br/>');
    return `
    <div class="field confirmation correction-done">
      <h3>Correction Request</h3>
      <p>Correction request submitted on ${requestedAtDisplay}.</p>
      <p>${commentHtml}</p>
    </div>`;
  }

  return `
    <div class="field confirmation">
      <h3>Your Response</h3>
      <p>Please review the project information shown above.</p>
      <form method="POST">
        <input type="hidden" name="action" value="confirm" />
        <button type="submit" class="confirm-button">Confirm project details</button>
      </form>
      <form method="POST" class="correction-form">
        <input type="hidden" name="action" value="request_correction" />
        <label for="correction-comment">Request corrections</label>
        <textarea
          id="correction-comment"
          name="comment"
          required
          maxlength="${MAX_CORRECTION_COMMENT_LENGTH}"
          aria-describedby="correction-comment-hint"
        ></textarea>
        <p id="correction-comment-hint" class="muted">Describe what needs to change. Up to ${MAX_CORRECTION_COMMENT_LENGTH} characters.</p>
        <button type="submit" class="correction-button">Request corrections</button>
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
  .correction-done p { color: #F59E0B; }
  .correction-form { margin-top: 1.25rem; }
  .correction-form label { display: block; font-size: 0.8rem; font-weight: 600; color: #D1D5DB; margin-bottom: 0.35rem; }
  .correction-form textarea { width: 100%; min-height: 6rem; padding: 0.6rem 0.75rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: #111827; color: #F3F4F6; font-family: inherit; font-size: 0.9rem; resize: vertical; }
  .correction-button { margin-top: 0.6rem; background: transparent; color: #F59E0B; border: 1px solid #F59E0B; padding: 0.6rem 1.3rem; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 0.9rem; }
  .correction-button:hover { background: rgba(245,158,11,0.1); }
`;

export function renderParticipantPreviewPage(params: {
  snapshot: ParticipantPreviewSnapshot;
  media: ParticipantPreviewMediaViewRef[];
  responseState: ParticipantPreviewResponseState;
}): string {
  const { snapshot, media, responseState } = params;

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
  ${renderParagraph('Poster Full Text', snapshot.posterText)}
  ${renderParagraph('Accessibility Description', snapshot.accessibilityText)}

  ${renderMedia(media, snapshot.accessibilityText)}

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

  ${renderResponseSection(responseState)}
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
