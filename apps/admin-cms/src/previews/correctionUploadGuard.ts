// Shared by the participant and staff transport routes: one bounded parser/upload
// at a time in this Node process, regardless of package provenance.
let inProgress = false;
export function acquireCorrectionUpload(): (() => void) | null {
  if (inProgress) return null;
  inProgress = true;
  return () => { inProgress = false; };
}
