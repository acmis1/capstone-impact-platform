/**
 * Retained command name for operator compatibility. Direct canonical Storage mutation is no
 * longer available: activation and project publication must use the ledger-backed Admin flow.
 */
// The optional argument list is accepted for operator/command compatibility and deliberately ignored.
export async function runPublishStagingFeed(_args?: string[]): Promise<boolean> {
  void _args;
  console.error('LEGACY_CANONICAL_WRITER_DISABLED');
  console.error('Use governed public-feed activation and controlled project publication in the Admin/CMS.');
  return false;
}

if (require.main === module) {
  runPublishStagingFeed().then(() => process.exit(1)).catch(() => process.exit(1));
}
