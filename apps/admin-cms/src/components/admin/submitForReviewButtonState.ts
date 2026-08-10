export function canSubmitForReview(pending: boolean, success: boolean, dirty: boolean): boolean {
  return !pending && !success && !dirty;
}
