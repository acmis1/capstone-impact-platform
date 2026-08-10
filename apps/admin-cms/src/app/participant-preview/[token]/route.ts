import { NextRequest } from 'next/server';
import { SupabaseParticipantPreviewRepository } from '../../../repositories/SupabaseParticipantPreviewRepository';
import { hashPreviewToken, isPlausibleRawPreviewToken } from '../../../previews/participantPreviewToken';
import { createSignedDraftMediaUrl } from '../../../storage/mediaStorage';
import { renderParticipantPreviewPage, renderParticipantPreviewUnavailablePage } from '../../../previews/participantPreviewHtml';
import { ParticipantPreviewMediaViewRef } from '../../../domain/participantPreview';

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
  'Content-Security-Policy':
    "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
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

  const html = renderParticipantPreviewPage({ snapshot: resolved.snapshot, media: mediaViews });
  return new Response(html, { status: 200, headers: RESPONSE_HEADERS });
}
