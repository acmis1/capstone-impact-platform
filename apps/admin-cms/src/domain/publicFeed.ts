import { ExternalLink, LayoutConfig, PublicSnapshotMedia } from './project';

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
  /**
   * Canonical public snapshot URL array. Unchanged and deliberately retained: the existing Duda
   * showcase consumes this exact shape.
   */
  snapshots: string[];
  /**
   * Additive structured pairing of each `snapshots` URL with its text alternative. Consuming this
   * in the Duda template is a separate later slice; publishing it here establishes the contract.
   */
  snapshotMedia: PublicSnapshotMedia[];
  videoUrl?: string;
  demoUrl?: string;
  repositoryUrl?: string;
  externalLinks?: ExternalLink[];
  citations?: string[];
  layoutConfig: LayoutConfig;
}
