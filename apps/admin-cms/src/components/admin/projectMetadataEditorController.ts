import { ProjectMetadataActionResult } from '../../projects/projectMetadata';

export async function invokeProjectMetadataSave(
  saveAction: (input: unknown) => Promise<ProjectMetadataActionResult>,
  input: unknown,
): Promise<ProjectMetadataActionResult> {
  try {
    return await saveAction(input);
  } catch {
    return { ok: false, code: 'INTERNAL_FAILURE', message: 'We could not save your changes. Please try again.' };
  }
}
