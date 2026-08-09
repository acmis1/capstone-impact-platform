/**
 * Centralized provisional validator for folder-derived public IDs.
 * 
 * Rules:
 * - Must be lowercase alphanumeric characters and single hyphens.
 * - Format regex: ^[a-z0-9]+(?:-[a-z0-9]+)*$
 * - Length between 1 and 100 characters.
 * 
 * Note: This is a provisional technical safety rule for folder-derived public IDs
 * and may be adjusted after formal stakeholder confirmation.
 */
export function validateFolderDerivedPublicId(folderName: string): { valid: boolean; message?: string } {
  if (!folderName || typeof folderName !== 'string') {
    return {
      valid: false,
      message: 'Folder name is empty or invalid.',
    };
  }

  const trimmed = folderName.trim();

  if (trimmed.length < 1 || trimmed.length > 100) {
    return {
      valid: false,
      message: 'Folder name length must be between 1 and 100 characters.',
    };
  }

  const validFormat = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!validFormat.test(trimmed)) {
    return {
      valid: false,
      message: 'Folder-derived public ID must consist of lowercase letters, numbers, and hyphens (e.g. "2026-project-alpha").',
    };
  }

  return { valid: true };
}
