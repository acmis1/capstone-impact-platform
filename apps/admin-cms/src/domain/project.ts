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
  groupName: string; // Student team group name
  teamMembers: string[]; // List of student names
  poster: string; // Public HTTPS URL to poster image preview
  posterPdf: string; // Public HTTPS URL to poster PDF file
  posterText: string; // Public-safe poster text content
  accessibilityText: string; // Public-safe accessibility description text
  snapshots: string[]; // Array of public snapshot image URLs
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
