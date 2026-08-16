export interface ImportPackageManifest {
  publicId: string;
  title: string;
  summary: string;
  background: string;
  solution: string;
  year: string;
  program: string;
  studyProgram: string;
  discipline: string;
  industry: string;
  industryPartner: string;
  academicSupervisor: string;
  groupName: string;
  /** Authoritative participant/group contact address; empty when the source left it blank. */
  participantContactEmail: string;
  teamMembers: string[];
  posterText?: string;
  accessibilityText?: string;
  /**
   * Staff-authored text alternative for the package's snapshot image. Absent when the source did
   * not supply one. Required only when the package actually contains a snapshot image, which is
   * enforced at the package-aware boundary (`validateImportPackage`) rather than by the individual
   * metadata parsers.
   */
  snapshotAltText?: string;
  layoutConfig: Record<string, unknown>;
}

export interface ImportPackageFileMetadata {
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
}

export interface ImportPackageFile extends ImportPackageFileMetadata {
  content: Buffer;
}

export interface ImportPackageParseResult<TFile extends ImportPackageFileMetadata = ImportPackageFile> {
  manifest: ImportPackageManifest;
  posterImage: TFile | null;
  posterPdf: TFile | null;
  snapshot1: TFile | null;
}

export interface ImportPackageValidationResult {
  valid: boolean;
  errors: Array<{
    ruleCode: string;
    message: string;
    fieldName?: string;
  }>;
  warnings: Array<{
    ruleCode: string;
    message: string;
    fieldName?: string;
  }>;
}

export interface ImportedProjectDraft {
  publicId: string;
  title: string;
  summary: string;
  background: string;
  solution: string;
  year: string;
  program: string;
  studyProgram: string;
  discipline: string;
  industry: string;
  industryPartner: string;
  academicSupervisor: string;
  groupName: string;
  /** Authoritative participant/group contact address; empty when the source left it blank. */
  participantContactEmail: string;
  teamMembers: string[];
  posterText?: string;
  accessibilityText?: string;
  layoutConfig: Record<string, unknown>;
  status: 'in_review';
}
