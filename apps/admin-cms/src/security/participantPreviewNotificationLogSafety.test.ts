import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A static guard for the one property this whole feature rests on: the raw participant preview
 * credential, the secure URL built from it, and the rendered message bodies exist only in transient
 * server memory and in the outgoing message. Nothing may write them to a log, a console, an
 * analytics call or a persisted record.
 *
 * This is asserted statically rather than only behaviourally because a leak is a one-line mistake
 * that no runtime assertion would necessarily exercise — a stray `console.log(previewUrl)` on an
 * error branch could ship unnoticed.
 */

const ROOT = path.resolve(__dirname, '../..');

const NOTIFICATION_SOURCES = [
  'src/notifications/participantPreviewNotificationService.ts',
  'src/notifications/participantPreviewEmailMessage.ts',
  'src/notifications/smtpParticipantPreviewEmailTransport.ts',
  'src/notifications/participantPreviewEmailConfig.ts',
  'src/notifications/participantPreviewNotification.ts',
  'src/notifications/participantPreviewEmailTransport.ts',
  'src/repositories/SupabaseParticipantPreviewNotificationRepositoryCore.ts',
  'src/app/api/projects/[publicId]/participant-preview/route.ts',
] as const;

/** Anything that writes to an output stream or a browser-observable sink. */
const OUTPUT_SINKS = [
  'console.log',
  'console.info',
  'console.debug',
  'console.warn',
  'console.trace',
  'process.stdout.write',
  'process.stderr.write',
  'localStorage',
  'sessionStorage',
] as const;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('participant preview notification log safety', () => {
  it.each(NOTIFICATION_SOURCES)('%s writes nothing to an output sink', (source) => {
    const content = read(source);
    for (const sink of OUTPUT_SINKS) {
      // console.error is permitted, but only for bounded codes — asserted separately below.
      expect(content).not.toContain(sink);
    }
  });

  it.each(NOTIFICATION_SOURCES)('%s never logs a credential, link or message body', (source) => {
    const content = read(source);
    const errorCalls = content.match(/console\.error\([^)]*\)/g) ?? [];
    for (const call of errorCalls) {
      for (const forbidden of ['previewUrl', 'previewToken', 'rawToken', 'executionToken', 'html', 'text', 'password']) {
        expect(call).not.toContain(forbidden);
      }
    }
  });

  it('keeps the secure link out of every persisted or returned notification shape', () => {
    const repository = read('src/repositories/SupabaseParticipantPreviewNotificationRepositoryCore.ts');
    // The read-model projection is explicit and must never widen to a wildcard select or reach for
    // an execution-control column. Only the projection constant itself is inspected, so the prose
    // explaining why those columns are excluded does not trip the assertion.
    const projection = repository.match(/const NOTIFICATION_VIEW_SELECT =[\s\S]*?;/)?.[0] ?? '';
    expect(projection).not.toBe('');
    expect(projection).not.toContain('*');
    expect(projection).not.toContain('execution_token_hash');
    expect(repository).not.toContain(".select('*')");
    expect(repository).not.toContain('previewUrl');
  });

  it('constructs the secure URL only inside the route, and hands it only to the transport', () => {
    const route = read('src/app/api/projects/[publicId]/participant-preview/route.ts');
    const service = read('src/notifications/participantPreviewNotificationService.ts');

    // Both delivery paths share one assembly point in the route, which is never persisted.
    expect(route.match(/const previewUrl = `\$\{publicOrigin\}\/participant-preview\/\$\{rawToken\}`/g))
      .toHaveLength(1);
    expect(route).not.toContain('previewUrl,\n          tokenHash');

    // The orchestration service passes it to rendering and to nothing else.
    expect(service).toContain('previewUrl: string;');
    expect(service).not.toMatch(/finalize\([^)]*previewUrl/);
  });

  it('never returns the execution ownership credential from the route', () => {
    const route = read('src/app/api/projects/[publicId]/participant-preview/route.ts');
    const responseBodies = route.match(/NextResponse\.json\([\s\S]*?\)/g) ?? [];
    for (const body of responseBodies) {
      expect(body).not.toContain('executionToken');
      expect(body).not.toContain('notificationId');
      expect(body).not.toContain('previewId');
      expect(body).not.toContain('tokenHash');
    }
  });

  it('keeps the runtime verifier from printing a credential or a message body', () => {
    const verifier = read('src/scripts/verifyParticipantPreviewNotificationRuntime.ts');
    const printed = [
      ...(verifier.match(/console\.log\([^)]*\)/g) ?? []),
      ...(verifier.match(/console\.error\([^)]*\)/g) ?? []),
    ];
    for (const call of printed) {
      for (const forbidden of ['Raw', 'raw', 'previewUrl', 'mailBody', 'Body', 'html', 'SERVICE_ROLE']) {
        expect(call).not.toContain(forbidden);
      }
    }
  });
});
