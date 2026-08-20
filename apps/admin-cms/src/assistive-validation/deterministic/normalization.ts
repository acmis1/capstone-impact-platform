/** Identity-oriented normalisation; it deliberately never removes words or digits. */
export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[.,;:!?()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

export function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function hasSuspiciousControlCharacters(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/.test(value);
}
