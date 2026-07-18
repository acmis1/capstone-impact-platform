import { ExternalLink, LayoutConfig } from './project';

/**
 * Public Data Contract representing a verified showcase record.
 * This object is fully stripped of all administrative tracking fields, staff notes, and private states.
 */
export interface PublicFeedRecord {
  id: number;
  publicId: string;
  title: string;
  summary: string;
  background: string;
  solution: string;
  year: string;
  program: string;
  studyProgram: string;
  discipline: string;
  disciplines: string[];
  industry: string;
  industryPartner: string;
  academicSupervisor: string;
  groupName: string;
  teamMembers: string[];
  poster: string;
  posterPdf: string;
  posterText: string;
  accessibilityText: string;
  snapshots: string[];
  videoUrl?: string;
  demoUrl?: string;
  repositoryUrl?: string;
  externalLinks?: ExternalLink[];
  citations?: string[];
  layoutConfig: LayoutConfig;
}
