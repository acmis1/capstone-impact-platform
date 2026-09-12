import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { readPreviewAccessReport, type PreviewAccessReportCursor } from '../previews/participantPreviewAccessReport';

function value(args: readonly string[], name: string): string | undefined {
  return args.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export async function runKpi09Report(args = process.argv.slice(2)): Promise<void> {
  if (!args.includes('--acknowledge-read-only-kpi09')) throw new Error('KPI09_OPERATOR_ACKNOWLEDGEMENT_REQUIRED');
  const issuedFrom = value(args, 'issued-from');
  const issuedBefore = value(args, 'issued-before');
  if (!issuedFrom || !issuedBefore) throw new Error('KPI09_COHORT_REQUIRED');
  const limitValue = value(args, 'limit');
  const cursorIssuedAt = value(args, 'cursor-issued-at');
  const cursorPreviewId = value(args, 'cursor-preview-id');
  if ((cursorIssuedAt === undefined) !== (cursorPreviewId === undefined)) throw new Error('KPI09_CURSOR_INCOMPLETE');
  const cursor: PreviewAccessReportCursor | undefined = cursorIssuedAt && cursorPreviewId
    ? { issuedAt: cursorIssuedAt, previewId: cursorPreviewId } : undefined;
  const report = await readPreviewAccessReport(createSupabaseAdminClientCore(), {
    issuedFrom, issuedBefore,
    limit: limitValue === undefined ? undefined : Number(limitValue),
    cursor,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  void runKpi09Report().catch((error) => {
    console.error(error instanceof Error ? error.message : 'KPI09_REPORT_FAILED');
    process.exitCode = 1;
  });
}
