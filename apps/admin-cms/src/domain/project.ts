import { WorkflowStatus } from './workflowStatus';

export interface ExternalLink {
  label: string;
  url: string;
}

export interface LayoutConfig {
  templateId: 'poster_showcase' | 'technical_detail' | 'media_rich' | string;
  featuredMedia: 'poster' | 'snapshots' | 'video' | string;
  sectionOrder: string[];
  hiddenSections?: string[];
}

export interface ValidationFlagRecord {
  hasErrors: boolean;
  hasWarnings: boolean;
  missingAccessibility?: boolean;
  missingSnapshots?: boolean;
  hasVideo?: boolean;
  hasAudio?: boolean;
  hasModel3d?: boolean;
}

/**
 * One public snapshot image paired with the text alternative that describes it. Both values are
 * public-safe by construction: the URL is the promoted public object and the alt text is the
 * staff-authored description carried through from the media asset.
 */
export interface PublicSnapshotMedia {
  url: string;
  altText: string;
}

export interface Project {
  // ==========================================
  // 1. PUBLIC-SAFE FIELDS (Visible in showcase feed)
  // ==========================================
  id: number; // Deterministic ID generated based on year and slug
  publicId?: string; // Original public ID (e.g. "2026-slug")
  title: string;
  summary: string;
  background: string;
  solution: string;
  year: string; // Academic year, e.g. "2026"
  program: string; // e.g. "Bachelor of Software Engineering"
  studyProgram: string; // Fallback representation matching template
  discipline: string; // Primary discipline, e.g. "Software Engineering"
  disciplines: string[]; // Disciplines list
  industry: string; // Industry sector category
  industryPartner: string; // Partner company name
  academicSupervisor: string; // Supervisor name
  groupName: string; // Project participant team group name
  // Authoritative participant/group contact address for participant preview correspondence.
  // Internal-only: never part of the public feed, and never accepted from a browser at send time.
  participantContactEmail: string;
  teamMembers: string[]; // List of project participant names
  poster: string; // Public HTTPS URL to poster image preview
  posterPdf: string; // Public HTTPS URL to poster PDF file
  posterText: string; // Public-safe poster text content
  accessibilityText: string; // Public-safe accessibility description text
  snapshots: string[]; // Array of public snapshot image URLs
  /**
   * The same public snapshot URLs as `snapshots`, each paired with its authoritative staff-authored
   * text alternative. Structured pairing rather than a parallel `snapshotAltTexts` array, because
   * two independent arrays can silently drift out of order and publish an image with someone else's
   * description.
   *
   * `snapshots` is retained unchanged as the canonical public URL array — the existing Duda
   * prototype consumes that shape — and this field is purely additive alongside it.
   */
  snapshotMedia: PublicSnapshotMedia[];
  videoUrl: string; // YouTube/Vimeo dynamic link
  demoUrl: string; // Dynamic prototype link
  repositoryUrl: string; // Git code repository link
  externalLinks: ExternalLink[]; // Array of project links
  citations: string[]; // Array of bibliographic citations
  layoutConfig: LayoutConfig; // Presets configuration

  // ==========================================
  // 2. INTERNAL-ONLY FIELDS (Restricted to CMS Database)
  // ==========================================
  status: WorkflowStatus; // Operational status in Admin workflow
  importBatchId?: string; // Links record to its Ingestion run
  sourceFolder?: string; // Naming path of the uploaded package
  internalStaffNotes?: string; // Private staff comments
  privateReviewComments?: string; // Private review notes
  validationFlags?: ValidationFlagRecord; // Inbound validation outcomes
  validationErrors?: string[]; // Log of blocking errors
  validationWarnings?: string[]; // Log of warnings
  pendingRemovalFromPublic?: boolean; // Removal flag active for Archived states
  publicRemovalCompletedAt?: string; // Timestamp logging showcase scrub completion
  archivedAt?: string; // Timestamp logging archive events
  archivedFromStatus?: string; // Tracks previous state before archival
  archiveReason?: string; // Captures audit reason for unpublishing
  created_at?: string;
  updated_at?: string;
}
