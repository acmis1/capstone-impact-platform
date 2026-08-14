import { NextRequest, NextResponse } from 'next/server';
import { SupabaseParticipantPreviewRepository } from '../../../repositories/SupabaseParticipantPreviewRepository';
import { hashPreviewToken, isPlausibleRawPreviewToken } from '../../../previews/participantPreviewToken';
import { createSignedDraftMediaUrl } from '../../../storage/mediaStorage';
import { renderParticipantPreviewPage, renderParticipantPreviewUnavailablePage } from '../../../previews/participantPreviewHtml';
import { validateCorrectionComment } from '../../../previews/participantPreviewCorrectionComment';
import { ParticipantPreviewMediaViewRef } from '../../../domain/participantPreview';
import { validateSameOrigin } from '../../../auth/csrf';

// Generous bound for a same-origin urlencoded form carrying only an action discriminator and, at
// most, a 2000-character correction comment (worst-case UTF-8 percent-encoding expansion), plus
// field-name overhead. Not the authoritative comment-length check — that is
// validateCorrectionComment plus the Migration 0015 RPC's own database-boundary validation.
const MAX_RESPONSE_FORM_BODY_BYTES = 32_768;

function parseContentLength(header: string | null): { bytes: number } | { code: 'ABSENT' | 'INVALID' | 'TOO_LARGE' } {
  if (header === null || header === '') return { code: 'ABSENT' };
  if (!/^(0|[1-9][0-9]*)$/.test(header)) return { code: 'INVALID' };
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes)) return { code: 'INVALID' };
  if (bytes > MAX_RESPONSE_FORM_BODY_BYTES) return { code: 'TOO_LARGE' };
  return { bytes };
}

/**
 * Reads the request body as raw bytes, aborting the moment the accumulated size exceeds `limit`.
 * This is the authoritative body-size boundary: a declared Content-Length is only an early
 * rejection signal when present (and is never required — participant form submissions omitting
 * it are otherwise valid), so the actual bytes read must be independently bounded regardless of
 * what, if anything, Content-Length claimed.
 */
async function readBoundedBody(request: NextRequest, limit: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Public, unauthenticated participant preview route. Token is the sole authorization
 * capability — there is no staff session involved. Every failure mode (unknown token,
 * malformed token, expired preview, revoked preview, missing media) renders the exact same
 * generic unavailable page, so the condition is never distinguishable from the response.
 *
 * Headers: no-store (never cached), noindex/nofollow (both header and meta tag), and a
 * restrictive referrer policy so the token embedded in this URL is never leaked via outgoing
 * Referer headers when a participant follows an external link from this page.
 */
const RESPONSE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  // Defense-in-depth only — never a substitute for the explicit href scheme validation in
  // participantPreviewHtml.ts. Blocks script execution and any non-declared external fetch.
  // form-action 'self' (rather than 'none') is required for the same-origin participant
  // confirmation POST form below; same-origin submission is separately and authoritatively
  // enforced server-side via validateSameOrigin, never by the CSP alone.
  'Content-Security-Policy':
    "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
} as const;

function unavailableResponse(status: number): Response {
  return new Response(renderParticipantPreviewUnavailablePage(), { status, headers: RESPONSE_HEADERS });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  if (!isPlausibleRawPreviewToken(token)) {
    return unavailableResponse(404);
  }

  const tokenHash = hashPreviewToken(token);
  const repository = new SupabaseParticipantPreviewRepository();

  let resolved;
  try {
    resolved = await repository.resolveByTokenHash(tokenHash);
  } catch {
    return unavailableResponse(500);
  }

  if (!resolved) {
    return unavailableResponse(404);
  }

  const mediaViews: ParticipantPreviewMediaViewRef[] = await Promise.all(
    resolved.mediaSnapshot.map(async (asset) => ({
      mediaAssetId: asset.mediaAssetId,
      assetType: asset.assetType,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      altText: asset.altText,
      signedUrl: await createSignedDraftMediaUrl({
        storageBucket: asset.storageBucket,
        storagePath: asset.storagePath,
      }),
    }))
  );

  // Fail closed: if the immutable snapshot expected media and any expected asset could not
  // receive a valid private signed URL, the participant must never see a partial/degraded page
  // (silently missing media) — render the same generic unavailable response instead.
  const hasUnsignableExpectedMedia = mediaViews.some((view) => !view.signedUrl);
  if (hasUnsignableExpectedMedia) {
    return unavailableResponse(404);
  }

  let responseState;
  try {
    responseState = await repository.getResponseState(resolved.previewId);
  } catch {
    return unavailableResponse(500);
  }

  // Fail closed for the same reason as an unsignable asset: if the immutable snapshot cannot supply
  // an authoritative text alternative for an image, the participant gets the generic unavailable
  // page rather than a page that shows them an image nobody can describe.
  let html: string;
  try {
    html = renderParticipantPreviewPage({ snapshot: resolved.snapshot, media: mediaViews, responseState });
  } catch {
    return unavailableResponse(404);
  }
  return new Response(html, { status: 200, headers: RESPONSE_HEADERS });
}

/**
 * Explicit participant response to the exact preview version currently shown: either
 * confirmation or a correction request, selected by a bounded `action` form field. The token
 * (from the URL, not the request body) remains the sole authorization capability — neither
 * response carries mutable project/preview data beyond the action discriminator and, for a
 * correction request, the participant-authored comment text. Same-origin is required since this
 * is a state-changing request despite the token capability.
 *
 * Every invalid-token condition (malformed, unknown, expired, revoked), every mutual-exclusion
 * loss (the other response type already recorded), and every backend failure renders the
 * identical generic unavailable response — the participant must never be able to distinguish
 * which condition occurred, nor learn whether a token hash exists. An invalid/oversized comment
 * redirects back without creating any row, so a participant can simply correct and resubmit.
 * Only an actual SUCCESS (including idempotent repeat submissions) follows a safe
 * POST/redirect/GET pattern: the subsequent GET resolves and renders the authoritative response
 * state, and a page refresh after redirect only re-issues that same GET, never another
 * submission.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const origin = request.headers.get('origin');
  if (!validateSameOrigin(origin, request.nextUrl.origin)) {
    return unavailableResponse(403);
  }

  if (!isPlausibleRawPreviewToken(token)) {
    return unavailableResponse(404);
  }

  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    return unavailableResponse(400);
  }

  const contentLength = parseContentLength(request.headers.get('content-length'));
  if ('code' in contentLength && contentLength.code !== 'ABSENT') {
    return unavailableResponse(400);
  }

  const bodyBytes = await readBoundedBody(request, MAX_RESPONSE_FORM_BODY_BYTES);
  if (bodyBytes === null) {
    return unavailableResponse(400);
  }

  const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);
  const searchParams = new URLSearchParams(bodyText);

  const actionEntries = searchParams.getAll('action');
  const action = actionEntries.length === 1 ? actionEntries[0] : null;

  const tokenHash = hashPreviewToken(token);
  const repository = new SupabaseParticipantPreviewRepository();
  const redirectToPreview = () =>
    NextResponse.redirect(new URL(`/participant-preview/${token}`, request.nextUrl.origin), {
      status: 303,
      headers: RESPONSE_HEADERS,
    });

  if (action === 'confirm') {
    let confirmation;
    try {
      confirmation = await repository.confirmPreview(tokenHash);
    } catch {
      return unavailableResponse(500);
    }

    if (!confirmation) {
      return unavailableResponse(404);
    }

    return redirectToPreview();
  }

  if (action === 'request_correction') {
    const commentEntries = searchParams.getAll('comment');
    const rawComment = commentEntries.length === 1 ? commentEntries[0] : null;
    const validation = validateCorrectionComment(rawComment);

    if (!validation.valid) {
      // Invalid/oversized comment: redirect back without ever calling the repository, so no row
      // is created and the participant can simply correct and resubmit.
      return redirectToPreview();
    }

    let correction;
    try {
      correction = await repository.requestCorrection(tokenHash, validation.comment);
    } catch {
      return unavailableResponse(500);
    }

    if (!correction) {
      return unavailableResponse(404);
    }

    return redirectToPreview();
  }

  return unavailableResponse(400);
}
