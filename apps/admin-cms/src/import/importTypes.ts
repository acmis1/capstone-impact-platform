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
  teamMembers: string[];
  posterText?: string;
  accessibilityText?: string;
  layoutConfig: Record<string, any>;
}

export interface ImportPackageFile {
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  content: Buffer;
}

export interface ImportPackageParseResult {
  manifest: ImportPackageManifest;
  posterImage: ImportPackageFile | null;
  posterPdf: ImportPackageFile | null;
  snapshot1: ImportPackageFile | null;
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
  teamMembers: string[];
  posterText?: string;
  accessibilityText?: string;
  layoutConfig: Record<string, any>;
  status: 'in_review';
}
