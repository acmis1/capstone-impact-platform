import {
  ParticipantPreviewMediaViewRef,
  ParticipantPreviewResponseState,
  ParticipantPreviewSnapshot,
} from '../domain/participantPreview';
import { MAX_CORRECTION_COMMENT_LENGTH } from './participantPreviewCorrectionComment';

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

/** Only absolute http(s) URLs may become participant-facing anchors. */
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

function renderList(items: string[], className = ''): string {
  if (items.length === 0) return '<p class="muted empty-value">None listed.</p>';
  const classAttribute = className ? ` class="${className}"` : '';
  return `<ul${classAttribute}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderLongText(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br />');
}

function renderProseField(label: string, value: string | null, className = ''): string {
  if (!value || value.trim() === '') return '';
  const classes = ['prose-field', className].filter(Boolean).join(' ');
  return `<section class="${classes}"><h3>${escapeHtml(label)}</h3><p>${renderLongText(value)}</p></section>`;
}

function renderExternalLinks(links: ParticipantPreviewSnapshot['externalLinks']): string {
  if (!links || links.length === 0) return '<p class="muted empty-value">None listed.</p>';
  return `<ul class="reference-list external-links">${links
    .map((link) => {
      const url = typeof link.url === 'string' ? link.url : '';
      const label = link.label && link.label.trim() !== '' ? link.label : url;
      if (!isSafeExternalPreviewUrl(url)) {
        return `<li><span class="unsafe-link-text">${escapeHtml(label)}</span></li>`;
      }
      return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(label)}<span class="link-purpose"> (opens in a new tab)</span></a></li>`;
    })
    .join('')}</ul>`;
}

/**
 * Uses only immutable accessibility evidence: project accessibility text for a poster and the
 * media snapshot's own alt text for a snapshot image. There is deliberately no filename/title
 * fallback; malformed evidence fails closed through the public route.
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

function renderImageFigure(
  media: ParticipantPreviewMediaViewRef,
  accessibilityText: string | null,
  kind: 'poster' | 'snapshot',
  index: number,
): string {
  const altText = resolveParticipantImageAlt(media, accessibilityText);
  if (altText === null) {
    throw new ParticipantPreviewMediaAccessibilityError(
      'Participant preview media is missing its authoritative text alternative.',
    );
  }
  const caption = kind === 'poster' ? 'Project poster' : `Supporting project image ${index + 1}`;
  return `<figure class="media-figure media-figure--${kind}" data-media-kind="${kind}">
    <div class="media-frame"><img src="${escapeHtml(media.signedUrl as string)}" alt="${escapeHtml(altText)}" loading="lazy" /></div>
    <figcaption>${caption}</figcaption>
  </figure>`;
}

function renderMedia(media: ParticipantPreviewMediaViewRef[], accessibilityText: string | null): string {
  const withUrl = media.filter((item) => item.signedUrl);
  if (withUrl.length === 0) return '';

  const posters = withUrl.filter((item) => item.assetType === 'poster_image');
  const snapshots = withUrl.filter((item) => item.assetType === 'snapshot_image');
  const documents = withUrl.filter(
    (item) => item.assetType !== 'poster_image' && item.assetType !== 'snapshot_image',
  );

  const postersHtml = posters
    .map((item, index) => renderImageFigure(item, accessibilityText, 'poster', index))
    .join('');
  const snapshotsHtml = snapshots
    .map((item, index) => renderImageFigure(item, accessibilityText, 'snapshot', index))
    .join('');
  const documentsHtml = documents
    .map(
      (item) => `<li><a class="document-link" data-media-kind="document" href="${escapeHtml(item.signedUrl as string)}" target="_blank" rel="noopener noreferrer nofollow">
        <span class="document-link__title">${escapeHtml(item.fileName)}</span>
        <span class="document-link__purpose">Open document in a new tab</span>
      </a></li>`,
    )
    .join('');

  return `<section class="review-section media-section" aria-labelledby="media-heading">
    <div class="section-heading">
      <p class="section-kicker">Visual and document evidence</p>
      <h2 id="media-heading">Project media</h2>
      <p>Review the poster, supporting images and documents as part of this exact private preview.</p>
    </div>
    ${postersHtml ? `<div class="poster-stage">${postersHtml}</div>` : ''}
    ${snapshotsHtml ? `<div class="supporting-media"><h3>Supporting images</h3><div class="snapshot-gallery">${snapshotsHtml}</div></div>` : ''}
    ${documentsHtml ? `<div class="document-assets"><h3>Project documents</h3><ul>${documentsHtml}</ul></div>` : ''}
  </section>`;
}

/**
 * Renders exactly one authoritative response state. Both unresponded options remain plain,
 * same-current-URL POST forms with no JavaScript and no mutable project data.
 */
function renderResponseSection(responseState: ParticipantPreviewResponseState): string {
  if (responseState.type === 'confirmed') {
    const confirmedAtDisplay = escapeHtml(new Date(responseState.confirmedAt).toUTCString());
    return `<aside class="response-column" aria-labelledby="response-heading">
      <div class="response-panel response-panel--complete" role="status">
        <p class="status-label status-label--confirmed">Confirmed</p>
        <h2 id="response-heading">Your Response</h2>
        <p class="response-lead">You confirmed that the project information shown in this exact preview is correct.</p>
        <p class="response-time">Recorded <time datetime="${escapeHtml(responseState.confirmedAt)}">${confirmedAtDisplay}</time></p>
        <p class="response-note">Confirmation does not publish the project. Staff will continue the review and publication process separately.</p>
      </div>
    </aside>`;
  }

  if (responseState.type === 'correction_requested') {
    const requestedAtDisplay = escapeHtml(new Date(responseState.requestedAt).toUTCString());
    const commentHtml = renderLongText(responseState.comment);
    return `<aside class="response-column" aria-labelledby="response-heading">
      <div class="response-panel response-panel--correction" role="status">
        <p class="status-label status-label--correction">Correction requested</p>
        <h2 id="response-heading">Your Response</h2>
        <p class="response-lead">Correction request submitted for this exact preview.</p>
        <p class="response-time">Recorded <time datetime="${escapeHtml(responseState.requestedAt)}">${requestedAtDisplay}</time></p>
        <div class="submitted-comment">
          <h3>Your comment</h3>
          <blockquote>${commentHtml}</blockquote>
        </div>
        <p class="response-note">Staff will review your request. The correction has not yet been applied.</p>
      </div>
    </aside>`;
  }

  return `<aside class="response-column" aria-labelledby="response-heading">
    <div class="response-panel">
      <p class="section-kicker">Decision</p>
      <h2 id="response-heading">Your Response</h2>
      <p class="response-lead">Review all project information and media above before choosing a response.</p>
      <div class="confirmation-choice">
        <h3>Everything is correct</h3>
        <p>Confirm that the information in this exact preview is ready for staff to continue reviewing.</p>
        <form method="POST">
          <input type="hidden" name="action" value="confirm" />
          <button type="submit" class="confirm-button">Confirm project details</button>
        </form>
      </div>
      <details class="correction-disclosure">
        <summary>Request corrections</summary>
        <div class="correction-content">
          <p>Describe what staff should change in this exact preview.</p>
          <form method="POST" class="correction-form">
            <input type="hidden" name="action" value="request_correction" />
            <label for="correction-comment">What needs to change?</label>
            <textarea
              id="correction-comment"
              name="comment"
              required
              maxlength="${MAX_CORRECTION_COMMENT_LENGTH}"
              aria-describedby="correction-comment-hint"
            ></textarea>
            <p id="correction-comment-hint" class="form-hint">Be specific. Up to ${MAX_CORRECTION_COMMENT_LENGTH} characters.</p>
            <button type="submit" class="correction-button">Submit correction request</button>
          </form>
        </div>
      </details>
      <p class="response-note">Neither response publishes the project. Staff manage publication separately.</p>
    </div>
  </aside>`;
}

function renderProjectMetadata(snapshot: ParticipantPreviewSnapshot): string {
  const values = [
    { label: 'Year', value: String(snapshot.year) },
    { label: 'Program', value: snapshot.program },
    { label: 'Discipline', value: snapshot.discipline },
  ].filter((item): item is { label: string; value: string } => Boolean(item.value));

  return `<dl class="project-meta">${values
    .map((item) => `<div><dt>${item.label}</dt><dd>${escapeHtml(item.value)}</dd></div>`)
    .join('')}</dl>`;
}

function renderOverview(snapshot: ParticipantPreviewSnapshot): string {
  const content = [
    renderProseField('Summary', snapshot.summary),
    renderProseField('Background', snapshot.background),
    renderProseField('Solution', snapshot.solution),
  ].join('');
  if (!content) return '';
  return `<section class="review-section overview-section" aria-labelledby="overview-heading">
    <div class="section-heading"><p class="section-kicker">Project evidence</p><h2 id="overview-heading">Project overview</h2></div>
    <div class="prose-stack">${content}</div>
  </section>`;
}

function renderAccessibleContent(snapshot: ParticipantPreviewSnapshot): string {
  const content = [
    renderProseField('Poster Full Text', snapshot.posterText, 'accessible-evidence'),
    renderProseField('Accessibility Description', snapshot.accessibilityText, 'accessible-evidence'),
  ].join('');
  if (!content) return '';
  return `<section class="review-section accessible-section" aria-labelledby="accessible-heading">
    <div class="section-heading">
      <p class="section-kicker">Accessible review evidence</p><h2 id="accessible-heading">Poster content in text</h2>
      <p>These text versions are part of the exact preview you are reviewing and confirming.</p>
    </div>
    <div class="accessible-content">${content}</div>
  </section>`;
}

function renderProjectContext(snapshot: ParticipantPreviewSnapshot): string {
  return `<section class="review-section context-section" aria-labelledby="context-heading">
    <div class="section-heading"><p class="section-kicker">People and context</p><h2 id="context-heading">Project and team details</h2></div>
    <div class="context-grid">
      <section class="context-group"><h3>Academic context</h3><dl>
        ${snapshot.academicSupervisor ? `<div><dt>Academic supervisor</dt><dd>${escapeHtml(snapshot.academicSupervisor)}</dd></div>` : ''}
        <div><dt>Disciplines</dt><dd>${renderList(snapshot.disciplines, 'compact-list')}</dd></div>
      </dl></section>
      <section class="context-group"><h3>Industry context</h3><dl>
        ${snapshot.industryPartner ? `<div><dt>Industry partner</dt><dd>${escapeHtml(snapshot.industryPartner)}</dd></div>` : ''}
        <div><dt>Industry categories</dt><dd>${renderList(snapshot.industryCategories, 'compact-list')}</dd></div>
      </dl></section>
      <section class="context-group team-group"><h3>Project team</h3>
        ${snapshot.groupName ? `<p class="group-name"><span>Group</span>${escapeHtml(snapshot.groupName)}</p>` : ''}
        ${renderList(snapshot.teamMembers, 'team-list')}
      </section>
    </div>
  </section>`;
}

function renderReferences(snapshot: ParticipantPreviewSnapshot): string {
  return `<section class="review-section references-section" aria-labelledby="references-heading">
    <div class="section-heading"><p class="section-kicker">Sources and further reading</p><h2 id="references-heading">References and links</h2></div>
    <div class="reference-grid">
      <section><h3>Citations</h3>${renderList(snapshot.citations, 'reference-list')}</section>
      <section><h3>External links</h3>${renderExternalLinks(snapshot.externalLinks)}</section>
    </div>
  </section>`;
}

/** Must match the route header while preserving a real same-origin POST Origin. */
const PAGE_REFERRER_POLICY = 'strict-origin';

/** Static participant-page colors, exported so regression tests calculate rendered contrast. */
export const PARTICIPANT_PREVIEW_COLORS = {
  'page-background': '#f4f5f7',
  surface: '#ffffff',
  'inset-surface': '#eef1f5',
  'text-primary': '#182230',
  'text-secondary': '#344054',
  'text-muted': '#5d6674',
  'border-subtle': '#d5dae2',
  'border-strong': '#667085',
  brand: '#b0003a',
  'brand-hover': '#8f002f',
  'brand-soft': '#f8e8ee',
  'private-text': '#751330',
  link: '#8a123b',
  'notice-background': '#eaf1fb',
  'notice-text': '#263f63',
  'success-background': '#e8f5ec',
  'success-text': '#17623a',
  'warning-background': '#fff3dc',
  'warning-text': '#754800',
  focus: '#005fcc',
  white: '#ffffff',
} as const;

const PAGE_COLOR_PROPERTIES = Object.entries(PARTICIPANT_PREVIEW_COLORS)
  .map(([name, value]) => `--color-${name}: ${value};`)
  .join(' ');

const PAGE_STYLE = `
  :root {
    color-scheme: light;
    ${PAGE_COLOR_PROPERTIES}
    --content-width: 1240px;
    --prose-measure: 72ch;
    --radius-small: 8px;
    --radius-medium: 14px;
    --radius-large: 20px;
    --shadow-subtle: 0 12px 32px rgba(24, 34, 48, 0.07);
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; min-width: 0; background: var(--color-page-background); color: var(--color-text-primary);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 16px; line-height: 1.65;
  }
  img { display: block; max-width: 100%; }
  button, textarea { font: inherit; }
  a { color: var(--color-link); text-underline-offset: 0.18em; text-decoration-thickness: 1px; }
  a:hover { text-decoration-thickness: 2px; }
  a, button, summary, textarea { border-radius: var(--radius-small); }
  a:focus-visible, button:focus-visible, summary:focus-visible, textarea:focus-visible {
    outline: 3px solid var(--color-focus); outline-offset: 3px;
  }
  .skip-link {
    position: fixed; z-index: 100; top: 12px; left: 12px; padding: 0.7rem 1rem;
    background: var(--color-text-primary); color: var(--color-white); font-weight: 700; transform: translateY(-160%);
  }
  .skip-link:focus { transform: translateY(0); }
  .page-header { background: var(--color-surface); border-bottom: 1px solid var(--color-border-subtle); }
  .header-inner {
    width: min(calc(100% - 3rem), var(--content-width)); min-height: 70px; margin: 0 auto; display: flex;
    align-items: center; justify-content: space-between; gap: 1rem;
  }
  .product-name { margin: 0; color: var(--color-text-primary); font-size: 1rem; font-weight: 760; letter-spacing: -0.01em; }
  .private-label {
    margin: 0; padding: 0.35rem 0.7rem; border: 1px solid #d8a7b7; border-radius: 999px;
    background: var(--color-brand-soft); color: var(--color-private-text); font-size: 0.8125rem; font-weight: 750;
  }
  .page-shell { width: min(calc(100% - 3rem), var(--content-width)); margin: 0 auto; padding: 2.5rem 0 3rem; }
  .project-header {
    padding: clamp(1.5rem, 3vw, 2.75rem); border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-large); background: var(--color-surface); box-shadow: var(--shadow-subtle);
  }
  .eyebrow, .section-kicker {
    margin: 0 0 0.4rem; color: var(--color-brand); font-size: 0.8125rem; font-weight: 760;
    letter-spacing: 0.035em; text-transform: uppercase;
  }
  h1 { max-width: 29ch; margin: 0; font-size: clamp(2rem, 4.2vw, 3.5rem); line-height: 1.08; letter-spacing: -0.035em; overflow-wrap: anywhere; }
  .project-introduction { max-width: 70ch; margin: 1.15rem 0 0; color: var(--color-text-secondary); font-size: 1.0625rem; overflow-wrap: anywhere; }
  .project-meta { display: flex; flex-wrap: wrap; gap: 0.75rem 1.75rem; margin: 1.5rem 0 0; }
  .project-meta div { min-width: 90px; max-width: 28rem; }
  .project-meta dt { color: var(--color-text-muted); font-size: 0.75rem; font-weight: 720; letter-spacing: 0.04em; text-transform: uppercase; }
  .project-meta dd { margin: 0.1rem 0 0; color: var(--color-text-primary); font-weight: 680; overflow-wrap: anywhere; }
  .private-notice {
    margin-top: 1.75rem; padding: 1rem 1.1rem; border: 1px solid #9eb4d2;
    border-radius: var(--radius-medium); background: var(--color-notice-background); color: var(--color-notice-text);
  }
  .private-notice p { margin: 0; }
  .private-notice__title { font-weight: 780; }
  .private-notice__body { margin-top: 0.2rem !important; }
  .review-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 2.5rem; align-items: start; margin-top: 2rem; }
  .review-content {
    min-width: 0; overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-large);
    background: var(--color-surface); box-shadow: var(--shadow-subtle);
  }
  .review-section { padding: clamp(1.5rem, 3vw, 2.5rem); }
  .review-section + .review-section { border-top: 1px solid var(--color-border-subtle); }
  .section-heading { max-width: var(--prose-measure); margin-bottom: 1.75rem; }
  .section-heading h2, .response-panel h2 { margin: 0; font-size: clamp(1.45rem, 2.2vw, 2rem); line-height: 1.2; letter-spacing: -0.02em; }
  .section-heading > p:last-child { margin: 0.55rem 0 0; color: var(--color-text-secondary); }
  .prose-stack { max-width: var(--prose-measure); }
  .prose-field + .prose-field { margin-top: 2rem; padding-top: 2rem; border-top: 1px solid var(--color-border-subtle); }
  .prose-field h3, .supporting-media h3, .document-assets h3, .context-group h3, .reference-grid h3, .submitted-comment h3, .confirmation-choice h3 {
    margin: 0 0 0.6rem; color: var(--color-text-primary); font-size: 1.0625rem; line-height: 1.35;
  }
  .prose-field p { margin: 0; color: var(--color-text-secondary); font-size: 1.0625rem; line-height: 1.75; }
  .accessible-content { max-width: var(--prose-measure); padding: 1.4rem; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-medium); background: var(--color-inset-surface); }
  .accessible-content .prose-field + .prose-field { border-color: #c9d0da; }
  .poster-stage { max-width: 720px; }
  .media-figure { margin: 0; }
  .media-frame { display: flex; align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-medium); background: var(--color-inset-surface); }
  .media-figure--poster .media-frame { min-height: 280px; max-height: 760px; padding: clamp(0.75rem, 2vw, 1.5rem); }
  .media-figure--poster img { width: auto; max-height: 710px; object-fit: contain; }
  .media-figure--snapshot .media-frame { aspect-ratio: 16 / 10; }
  .media-figure--snapshot img { width: 100%; height: 100%; object-fit: contain; }
  figcaption { margin-top: 0.55rem; color: var(--color-text-muted); font-size: 0.875rem; font-weight: 650; }
  .supporting-media, .document-assets { margin-top: 2rem; padding-top: 2rem; border-top: 1px solid var(--color-border-subtle); }
  .snapshot-gallery { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  .document-assets ul { margin: 0; padding: 0; list-style: none; }
  .document-link { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 64px; padding: 0.8rem 1rem; border: 1px solid var(--color-border-strong); background: var(--color-surface); text-decoration: none; }
  .document-link:hover { background: var(--color-inset-surface); }
  .document-link__title { font-weight: 750; overflow-wrap: anywhere; }
  .document-link__purpose { color: var(--color-text-secondary); font-size: 0.8125rem; text-align: right; }
  .context-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2rem; }
  .context-group { min-width: 0; padding-left: 1.1rem; border-left: 3px solid var(--color-border-subtle); }
  .context-group dl { margin: 0; }
  .context-group dl > div + div { margin-top: 1.25rem; }
  .context-group dt, .group-name span { display: block; color: var(--color-text-muted); font-size: 0.75rem; font-weight: 720; letter-spacing: 0.035em; text-transform: uppercase; }
  .context-group dd { margin: 0.2rem 0 0; color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .team-group { grid-column: 1 / -1; }
  .group-name { margin: 0 0 1rem; color: var(--color-text-secondary); font-weight: 650; }
  .team-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.35rem 1.25rem; margin: 0; padding-left: 1.2rem; color: var(--color-text-secondary); }
  .team-list li, .compact-list li, .reference-list li { min-width: 0; overflow-wrap: anywhere; }
  .compact-list { margin: 0; padding-left: 1.15rem; }
  .reference-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); gap: 2rem; }
  .reference-list { margin: 0; padding-left: 1.2rem; color: var(--color-text-secondary); }
  .reference-list li + li { margin-top: 0.55rem; }
  .external-links a, .unsafe-link-text { overflow-wrap: anywhere; }
  .link-purpose { white-space: nowrap; font-size: 0.8125rem; }
  .muted, .form-hint { color: var(--color-text-muted); }
  .empty-value { margin: 0; font-style: italic; }
  .response-column { min-width: 0; }
  .response-panel { position: sticky; top: 1.5rem; padding: 1.5rem; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-large); background: var(--color-surface); box-shadow: var(--shadow-subtle); }
  .response-lead { margin: 0.75rem 0 0; color: var(--color-text-secondary); }
  .confirmation-choice { margin-top: 1.5rem; padding: 1.1rem; border: 1px solid #d8a7b7; border-radius: var(--radius-medium); background: var(--color-brand-soft); }
  .confirmation-choice p { margin: 0 0 1rem; color: var(--color-text-secondary); }
  form { margin: 0; }
  .confirm-button, .correction-button { min-height: 48px; width: 100%; padding: 0.7rem 1rem; cursor: pointer; font-weight: 780; }
  .confirm-button { border: 2px solid var(--color-brand); background: var(--color-brand); color: var(--color-white); }
  .confirm-button:hover { border-color: var(--color-brand-hover); background: var(--color-brand-hover); }
  .correction-disclosure { margin-top: 1rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-medium); background: var(--color-surface); }
  .correction-disclosure summary { min-height: 46px; padding: 0.65rem 1rem; color: var(--color-link); cursor: pointer; font-weight: 760; }
  .correction-disclosure[open] summary { border-bottom: 1px solid var(--color-border-subtle); }
  .correction-content { padding: 1rem; }
  .correction-content > p { margin: 0 0 0.9rem; color: var(--color-text-secondary); }
  .correction-form label { display: block; margin-bottom: 0.4rem; color: var(--color-text-primary); font-weight: 720; }
  .correction-form textarea { width: 100%; min-height: 140px; padding: 0.75rem; border: 2px solid var(--color-border-strong); background: var(--color-surface); color: var(--color-text-primary); line-height: 1.55; resize: vertical; }
  .form-hint { margin: 0.35rem 0 0.9rem; font-size: 0.8125rem; }
  .correction-button { border: 2px solid var(--color-link); background: var(--color-surface); color: var(--color-link); }
  .correction-button:hover { background: var(--color-inset-surface); }
  .response-note { margin: 1.25rem 0 0; padding-top: 1rem; border-top: 1px solid var(--color-border-subtle); color: var(--color-text-muted); font-size: 0.875rem; }
  .status-label { display: inline-flex; margin: 0 0 0.7rem; padding: 0.3rem 0.65rem; border-radius: 999px; font-size: 0.8125rem; font-weight: 800; }
  .status-label--confirmed { border: 1px solid #75ad8b; background: var(--color-success-background); color: var(--color-success-text); }
  .status-label--correction { border: 1px solid #c69a45; background: var(--color-warning-background); color: var(--color-warning-text); }
  .response-panel--complete { border-top: 5px solid var(--color-success-text); }
  .response-panel--correction { border-top: 5px solid var(--color-warning-text); }
  .response-time { margin: 1rem 0 0; color: var(--color-text-secondary); font-size: 0.875rem; }
  .submitted-comment { margin-top: 1.25rem; padding: 1rem; border: 1px solid #c69a45; border-radius: var(--radius-medium); background: var(--color-warning-background); }
  .submitted-comment blockquote { margin: 0; color: var(--color-warning-text); overflow-wrap: anywhere; }
  .page-footer { width: min(calc(100% - 3rem), var(--content-width)); margin: 0 auto; padding: 0 0 2.5rem; color: var(--color-text-muted); font-size: 0.875rem; }
  .page-footer p { margin: 0; }
  .unavailable-shell { min-height: calc(100vh - 70px); display: grid; place-items: center; }
  .unavailable-card { width: min(100%, 680px); padding: clamp(1.75rem, 5vw, 3rem); border: 1px solid var(--color-border-subtle); border-radius: var(--radius-large); background: var(--color-surface); box-shadow: var(--shadow-subtle); text-align: center; }
  .unavailable-card h1 { max-width: none; font-size: clamp(2rem, 5vw, 3rem); }
  .unavailable-card p { max-width: 54ch; margin: 1rem auto 0; color: var(--color-text-secondary); }
  @media (max-width: 1040px) {
    .review-layout { grid-template-columns: minmax(0, 1fr) 320px; gap: 1.5rem; }
  }
  @media (max-width: 900px) {
    .review-layout { grid-template-columns: minmax(0, 1fr); }
    .response-panel { position: static; }
  }
  @media (max-width: 680px) {
    .header-inner, .page-shell, .page-footer { width: min(calc(100% - 2rem), var(--content-width)); }
    .header-inner { min-height: 62px; align-items: flex-start; flex-direction: column; justify-content: center; gap: 0.15rem; padding: 0.65rem 0; }
    .private-label { padding: 0; border: 0; background: transparent; }
    .page-shell { padding-top: 1rem; }
    .project-header, .review-content, .response-panel { border-radius: var(--radius-medium); }
    h1 { font-size: clamp(1.8rem, 9vw, 2.45rem); }
    .project-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
    .project-meta div { min-width: 0; }
    .review-layout { margin-top: 1rem; }
    .review-section { padding: 1.35rem; }
    .snapshot-gallery, .context-grid, .reference-grid { grid-template-columns: minmax(0, 1fr); }
    .team-group { grid-column: auto; }
    .team-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .document-link { align-items: flex-start; flex-direction: column; gap: 0.15rem; }
    .document-link__purpose { text-align: left; }
    .link-purpose { white-space: normal; }
  }
  @media (max-width: 420px) {
    .project-meta, .team-list { grid-template-columns: minmax(0, 1fr); }
    .project-introduction, .prose-field p { font-size: 1rem; }
    .accessible-content, .confirmation-choice { padding: 1rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  }
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
<meta name="referrer" content="${PAGE_REFERRER_POLICY}" />
<title>${escapeHtml(snapshot.title)} — Participant Preview</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to project review</a>
<header class="page-header"><div class="header-inner"><p class="product-name">Capstone project review</p><p class="private-label">Private participant preview</p></div></header>
<main id="main-content" class="page-shell">
  <header class="project-header">
    <p class="eyebrow">Review this project</p>
    <h1>${escapeHtml(snapshot.title)}</h1>
    ${renderProjectMetadata(snapshot)}
    <p class="project-introduction">Please check the project information, media and accessible text below. Your response applies only to this exact preview version.</p>
    <div class="private-notice" role="note">
      <p class="private-notice__title">This is a private preview prepared for the project team.</p>
      <p class="private-notice__body">It is not publicly listed or searchable. Confirmation does not publish the project.</p>
    </div>
  </header>
  <div class="review-layout">
    <article class="review-content" aria-label="Project information to review">
      ${renderOverview(snapshot)}
      ${renderMedia(media, snapshot.accessibilityText)}
      ${renderAccessibleContent(snapshot)}
      ${renderProjectContext(snapshot)}
      ${renderReferences(snapshot)}
    </article>
    ${renderResponseSection(responseState)}
  </div>
</main>
<footer class="page-footer"><p>This private preview is provided for project review only. Contact your project coordinator if you need help.</p></footer>
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
<meta name="referrer" content="${PAGE_REFERRER_POLICY}" />
<title>Preview Unavailable</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to preview status</a>
<header class="page-header"><div class="header-inner"><p class="product-name">Capstone project review</p><p class="private-label">Private participant preview</p></div></header>
<main id="main-content" class="page-shell unavailable-shell">
  <section class="unavailable-card">
    <p class="eyebrow">Private preview</p>
    <h1>Preview Unavailable</h1>
    <p>This preview link is invalid, expired, or has been revoked. Please contact your project coordinator for a current link.</p>
  </section>
</main>
</body>
</html>`;
}
