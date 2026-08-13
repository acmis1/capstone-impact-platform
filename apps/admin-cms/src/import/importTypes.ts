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
