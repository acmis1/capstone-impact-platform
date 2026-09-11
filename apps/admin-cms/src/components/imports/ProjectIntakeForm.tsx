'use client';

import React, { useState, useRef } from 'react';
import {
  Plus,
  Trash2,
  FileCheck2,
  RotateCcw,
} from 'lucide-react';
import {
  FormIntakeMetadata,
  FormIntakeMediaState,
  createInitialFormIntakeMetadata,
  createInitialFormIntakeMediaState,
} from '../../import/formIntakeContract';
import { validateFormIntake } from '../../import/formIntakeValidation';
import {
  materializeFormIntakePackage,
  MaterializedPackageFiles,
} from '../../import/formIntakeMaterializerClient';
import { ACCESSIBLE_CONTENT_LIMITS } from '../../domain/accessibleContent';
import type { SnapshotImageContentKind } from '../../domain/galleryTextEquivalent';
import { MAX_GALLERY_IMAGES } from '../../import/galleryConvention';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Button } from '../ui/button';
import { Alert } from '../ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { cn } from '../../lib/utils';

export interface ProjectIntakeFormProps {
  onPackageReady: (pkg: MaterializedPackageFiles) => Promise<void>;
  disabled?: boolean;
}

export function ProjectIntakeForm({ onPackageReady, disabled = false }: ProjectIntakeFormProps) {
  const [metadata, setMetadata] = useState<FormIntakeMetadata>(createInitialFormIntakeMetadata());
  const [media, setMedia] = useState<FormIntakeMediaState>(createInitialFormIntakeMediaState());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isMaterializing, setIsMaterializing] = useState<boolean>(false);
  const [visibleGalleryCount, setVisibleGalleryCount] = useState<number>(1);

  const submissionLockRef = useRef<boolean>(false);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const posterImageInputRef = useRef<HTMLInputElement>(null);
  const posterPdfInputRef = useRef<HTMLInputElement>(null);

  const handleMetadataChange = (field: keyof FormIntakeMetadata, value: string) => {
    setMetadata((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const handlePosterImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setMedia((prev) => ({ ...prev, posterImage: file }));
    if (errors.posterImage) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next.posterImage;
        return next;
      });
    }
  };

  const handlePosterPdfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setMedia((prev) => ({ ...prev, posterPdf: file }));
    if (errors.posterPdf) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next.posterPdf;
        return next;
      });
    }
  };

  const handleGalleryFileChange = (position: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setMedia((prev) => ({
      ...prev,
      galleryImages: prev.galleryImages.map((g) =>
        g.position === position ? { ...g, file } : g
      ),
    }));
    if (errors[`galleryImage_${position}`]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[`galleryImage_${position}`];
        return next;
      });
    }
  };

  const handleGalleryAltChange = (position: number, altText: string) => {
    setMedia((prev) => ({
      ...prev,
      galleryImages: prev.galleryImages.map((g) =>
        g.position === position ? { ...g, altText } : g
      ),
    }));
    if (errors[`galleryAlt_${position}`]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[`galleryAlt_${position}`];
        return next;
      });
    }
  };

  const handleGalleryContentKindChange = (
    position: number,
    contentKind: SnapshotImageContentKind | ''
  ) => {
    setMedia((prev) => ({
      ...prev,
      galleryImages: prev.galleryImages.map((g) =>
        g.position === position
          ? {
              ...g,
              contentKind,
              fullText: contentKind === 'ordinary' ? '' : g.fullText,
            }
          : g
      ),
    }));
    if (errors[`galleryContentKind_${position}`]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[`galleryContentKind_${position}`];
        return next;
      });
    }
    if (contentKind === 'ordinary' && errors[`galleryFullText_${position}`]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[`galleryFullText_${position}`];
        return next;
      });
    }
  };

  const handleGalleryFullTextChange = (position: number, fullText: string) => {
    setMedia((prev) => ({
      ...prev,
      galleryImages: prev.galleryImages.map((g) =>
        g.position === position ? { ...g, fullText } : g
      ),
    }));
    if (errors[`galleryFullText_${position}`]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[`galleryFullText_${position}`];
        return next;
      });
    }
  };

  const handleClearGalleryItem = (position: number) => {
    setMedia((prev) => ({
      ...prev,
      galleryImages: prev.galleryImages.map((g) =>
        g.position === position
          ? { ...g, file: null, altText: '', contentKind: '', fullText: '' }
          : g
      ),
    }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[`galleryImage_${position}`];
      delete next[`galleryAlt_${position}`];
      delete next[`galleryContentKind_${position}`];
      delete next[`galleryFullText_${position}`];
      return next;
    });
  };

  const handleResetForm = () => {
    if (disabled || isMaterializing) return;
    setMetadata(createInitialFormIntakeMetadata());
    setMedia(createInitialFormIntakeMediaState());
    setErrors({});
    setSubmissionError(null);
    setVisibleGalleryCount(1);
    if (posterImageInputRef.current) posterImageInputRef.current.value = '';
    if (posterPdfInputRef.current) posterPdfInputRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || isMaterializing || submissionLockRef.current) return;

    setSubmissionError(null);

    // 1. Client validation
    const validation = validateFormIntake(metadata, media);
    if (!validation.valid) {
      setErrors(validation.errors);
      const firstErrorKey = validation.errorSummary[0]?.fieldName;
      if (firstErrorKey) {
        const errorEl = document.getElementById(firstErrorKey);
        if (errorEl) {
          errorEl.focus();
          if (typeof errorEl.scrollIntoView === 'function') {
            errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        } else if (errorSummaryRef.current) {
          errorSummaryRef.current.focus();
          if (typeof errorSummaryRef.current.scrollIntoView === 'function') {
            errorSummaryRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
      return;
    }

    // 2. Lock & Materialize
    submissionLockRef.current = true;
    setIsMaterializing(true);

    try {
      const result = await materializeFormIntakePackage(metadata, media);
      if (!result.success) {
        setSubmissionError(result.error);
        return;
      }

      await onPackageReady(result.package);
    } catch {
      setSubmissionError('An unexpected error occurred while preparing the project import.');
    } finally {
      setIsMaterializing(false);
      submissionLockRef.current = false;
    }
  };

  const isFieldDisabled = disabled || isMaterializing;

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
      {/* Top Submission Error Alert */}
      {submissionError && (
        <Alert
          variant="destructive"
          title="Workbook Generation Failed"
          description={submissionError}
        />
      )}

      {/* Top Validation Error Summary */}
      {Object.keys(errors).length > 0 && (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          role="alert"
          aria-live="assertive"
          className="p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-xs flex flex-col gap-2 focus:outline-none focus:ring-2 focus:ring-destructive"
        >
          <div className="font-semibold text-destructive flex items-center gap-1.5">
            <span>Please resolve {Object.keys(errors).length} form error(s) before continuing:</span>
          </div>
          <ul className="list-disc list-inside space-y-1 text-foreground">
            {Object.entries(errors).map(([field, msg]) => (
              <li key={field}>
                <a
                  href={`#${field}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(field)?.focus();
                    document.getElementById(field)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }}
                  className="underline hover:text-destructive font-medium"
                >
                  {msg}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 1. Project Identification */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <CardTitle className="text-sm font-semibold text-foreground">
            1. Project Identification
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Unique canonical project identifier used for repository folder naming and project URLs.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="publicId" isRequired>
              Project Identifier (Public ID)
            </Label>
            <Input
              id="publicId"
              value={metadata.publicId}
              onChange={(e) => handleMetadataChange('publicId', e.target.value)}
              disabled={isFieldDisabled}
              placeholder="e.g. smart-grid-monitor"
              isInvalid={Boolean(errors.publicId)}
              aria-describedby={errors.publicId ? 'err-publicId' : 'desc-publicId'}
              aria-required="true"
            />
            <p id="desc-publicId" className="text-xs text-muted-foreground">
              Lowercase alphanumeric characters and hyphens only (e.g. rover-navigation-2026).
            </p>
            {errors.publicId && (
              <p id="err-publicId" className="text-xs text-destructive font-medium" role="alert">
                {errors.publicId}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 2. Core Project Information */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <CardTitle className="text-sm font-semibold text-foreground">
            2. Core Project Information
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Authoritative descriptive text shown to public visitors and reviewers.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="title" isRequired>
              Project Title
            </Label>
            <Input
              id="title"
              value={metadata.title}
              onChange={(e) => handleMetadataChange('title', e.target.value)}
              disabled={isFieldDisabled}
              placeholder="Full capstone project title"
              isInvalid={Boolean(errors.title)}
              aria-describedby={errors.title ? 'err-title' : undefined}
              aria-required="true"
            />
            {errors.title && (
              <p id="err-title" className="text-xs text-destructive font-medium" role="alert">
                {errors.title}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="summary" isRequired>
              Short Public Summary
            </Label>
            <Textarea
              id="summary"
              value={metadata.summary}
              onChange={(e) => handleMetadataChange('summary', e.target.value)}
              disabled={isFieldDisabled}
              placeholder="A concise 1-2 paragraph overview of the project"
              isInvalid={Boolean(errors.summary)}
              aria-describedby={errors.summary ? 'err-summary' : undefined}
              aria-required="true"
              className="min-h-[90px]"
            />
            {errors.summary && (
              <p id="err-summary" className="text-xs text-destructive font-medium" role="alert">
                {errors.summary}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="background">Project Background (Optional)</Label>
              <Textarea
                id="background"
                value={metadata.background}
                onChange={(e) => handleMetadataChange('background', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="Industry context or research motivation"
                className="min-h-[80px]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="solution">Solution / Impact (Optional)</Label>
              <Textarea
                id="solution"
                value={metadata.solution}
                onChange={(e) => handleMetadataChange('solution', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="Key outcomes, technical results, and impact"
                className="min-h-[80px]"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. Academic & Industry Details */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <CardTitle className="text-sm font-semibold text-foreground">
            3. Academic & Industry Details
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Program affiliation, supervisory context, and team participants.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="program" isRequired>
                Study Program
              </Label>
              <Input
                id="program"
                value={metadata.program}
                onChange={(e) => handleMetadataChange('program', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="e.g. Bachelor of Computer Science"
                isInvalid={Boolean(errors.program)}
                aria-describedby={errors.program ? 'err-program' : undefined}
                aria-required="true"
              />
              {errors.program && (
                <p id="err-program" className="text-xs text-destructive font-medium" role="alert">
                  {errors.program}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="discipline" isRequired>
                Primary Discipline
              </Label>
              <Input
                id="discipline"
                value={metadata.discipline}
                onChange={(e) => handleMetadataChange('discipline', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="e.g. Software Engineering"
                isInvalid={Boolean(errors.discipline)}
                aria-describedby={errors.discipline ? 'err-discipline' : undefined}
                aria-required="true"
              />
              {errors.discipline && (
                <p id="err-discipline" className="text-xs text-destructive font-medium" role="alert">
                  {errors.discipline}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="year" isRequired>
                Project Year
              </Label>
              <Input
                id="year"
                value={metadata.year}
                onChange={(e) => handleMetadataChange('year', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="2026"
                isInvalid={Boolean(errors.year)}
                aria-describedby={errors.year ? 'err-year' : undefined}
                aria-required="true"
              />
              {errors.year && (
                <p id="err-year" className="text-xs text-destructive font-medium" role="alert">
                  {errors.year}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="groupName" isRequired>
                Group Name
              </Label>
              <Input
                id="groupName"
                value={metadata.groupName}
                onChange={(e) => handleMetadataChange('groupName', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="Official student group name"
                isInvalid={Boolean(errors.groupName)}
                aria-describedby={errors.groupName ? 'err-groupName' : undefined}
                aria-required="true"
              />
              {errors.groupName && (
                <p id="err-groupName" className="text-xs text-destructive font-medium" role="alert">
                  {errors.groupName}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="participantContactEmail">
                Participant Contact Email (Optional)
              </Label>
              <Input
                id="participantContactEmail"
                type="email"
                value={metadata.participantContactEmail}
                onChange={(e) => handleMetadataChange('participantContactEmail', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="group-lead@student.rmit.edu.au"
                isInvalid={Boolean(errors.participantContactEmail)}
                aria-describedby={errors.participantContactEmail ? 'err-email' : undefined}
              />
              {errors.participantContactEmail && (
                <p id="err-email" className="text-xs text-destructive font-medium" role="alert">
                  {errors.participantContactEmail}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="teamMembers" isRequired>
              Team Members
            </Label>
            <Textarea
              id="teamMembers"
              value={metadata.teamMembers}
              onChange={(e) => handleMetadataChange('teamMembers', e.target.value)}
              disabled={isFieldDisabled}
              placeholder="List student team members (one per line or separated by commas)"
              isInvalid={Boolean(errors.teamMembers)}
              aria-describedby={errors.teamMembers ? 'err-teamMembers' : undefined}
              aria-required="true"
              className="min-h-[80px]"
            />
            {errors.teamMembers && (
              <p id="err-teamMembers" className="text-xs text-destructive font-medium" role="alert">
                {errors.teamMembers}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="academicSupervisor">Academic Supervisor (Optional)</Label>
              <Input
                id="academicSupervisor"
                value={metadata.academicSupervisor}
                onChange={(e) => handleMetadataChange('academicSupervisor', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="Supervisor name"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="industryPartner">Industry Partner (Optional)</Label>
              <Input
                id="industryPartner"
                value={metadata.industryPartner}
                onChange={(e) => handleMetadataChange('industryPartner', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="Partner organization"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="industry">Industry Sector (Optional)</Label>
              <Input
                id="industry"
                value={metadata.industry}
                onChange={(e) => handleMetadataChange('industry', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="e.g. Healthcare, Finance"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4. Showcase & Layout Preferences */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <CardTitle className="text-sm font-semibold text-foreground">
            4. Showcase & Layout Preferences
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Template and primary media presentation choices.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="templateId">Showcase Layout</Label>
              <select
                id="templateId"
                value={metadata.templateId}
                onChange={(e) => handleMetadataChange('templateId', e.target.value)}
                disabled={isFieldDisabled}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="poster_showcase">Poster Showcase (Poster first)</option>
                <option value="technical_detail">Technical Detail (Report first)</option>
                <option value="media_rich">Media Rich (Video & Gallery first)</option>
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="featuredMedia">Main Media to Feature</Label>
              <select
                id="featuredMedia"
                value={metadata.featuredMedia}
                onChange={(e) => handleMetadataChange('featuredMedia', e.target.value)}
                disabled={isFieldDisabled}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="poster">Poster Image</option>
                <option value="snapshots">Snapshot Gallery</option>
                <option value="video">Project Video</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 5. External Controlled URLs */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <CardTitle className="text-sm font-semibold text-foreground">
            5. External Links (Optional)
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Public HTTP/HTTPS links without embedded credentials.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="videoUrl">Project Video URL</Label>
              <Input
                id="videoUrl"
                type="url"
                value={metadata.videoUrl}
                onChange={(e) => handleMetadataChange('videoUrl', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="https://youtube.com/watch?v=..."
                isInvalid={Boolean(errors.videoUrl)}
                aria-describedby={errors.videoUrl ? 'err-videoUrl' : undefined}
              />
              {errors.videoUrl && (
                <p id="err-videoUrl" className="text-xs text-destructive font-medium" role="alert">
                  {errors.videoUrl}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="demoUrl">Live Demo URL</Label>
              <Input
                id="demoUrl"
                type="url"
                value={metadata.demoUrl}
                onChange={(e) => handleMetadataChange('demoUrl', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="https://demo.example.edu"
                isInvalid={Boolean(errors.demoUrl)}
                aria-describedby={errors.demoUrl ? 'err-demoUrl' : undefined}
              />
              {errors.demoUrl && (
                <p id="err-demoUrl" className="text-xs text-destructive font-medium" role="alert">
                  {errors.demoUrl}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repositoryUrl">Source Repository URL</Label>
              <Input
                id="repositoryUrl"
                type="url"
                value={metadata.repositoryUrl}
                onChange={(e) => handleMetadataChange('repositoryUrl', e.target.value)}
                disabled={isFieldDisabled}
                placeholder="https://github.com/org/repo"
                isInvalid={Boolean(errors.repositoryUrl)}
                aria-describedby={errors.repositoryUrl ? 'err-repositoryUrl' : undefined}
              />
              {errors.repositoryUrl && (
                <p id="err-repositoryUrl" className="text-xs text-destructive font-medium" role="alert">
                  {errors.repositoryUrl}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 6. Accessible Poster Content */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <CardTitle className="text-sm font-semibold text-foreground">
            6. Accessible Poster Content
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Required accessibility transcriptions for inclusive public access.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between items-center">
              <Label htmlFor="posterText" isRequired>
                Poster Full Text
              </Label>
              <span className="text-xs text-muted-foreground">
                {(metadata.posterText || '').trim().length} / {ACCESSIBLE_CONTENT_LIMITS.posterText.toLocaleString()}
              </span>
            </div>
            <Textarea
              id="posterText"
              value={metadata.posterText}
              onChange={(e) => handleMetadataChange('posterText', e.target.value)}
              disabled={isFieldDisabled}
              placeholder="Full text transcript of all meaningful content appearing on the poster"
              isInvalid={Boolean(errors.posterText)}
              aria-describedby={errors.posterText ? 'err-posterText' : undefined}
              aria-required="true"
              className="min-h-[100px]"
            />
            {errors.posterText && (
              <p id="err-posterText" className="text-xs text-destructive font-medium" role="alert">
                {errors.posterText}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between items-center">
              <Label htmlFor="accessibilityText" isRequired>
                Accessibility Description (Alt text)
              </Label>
              <span className="text-xs text-muted-foreground">
                {(metadata.accessibilityText || '').trim().length} / {ACCESSIBLE_CONTENT_LIMITS.accessibilityText.toLocaleString()}
              </span>
            </div>
            <Input
              id="accessibilityText"
              value={metadata.accessibilityText}
              onChange={(e) => handleMetadataChange('accessibilityText', e.target.value)}
              disabled={isFieldDisabled}
              placeholder="Concise descriptive text alternative for the poster image"
              isInvalid={Boolean(errors.accessibilityText)}
              aria-describedby={errors.accessibilityText ? 'err-accessibilityText' : undefined}
              aria-required="true"
            />
            {errors.accessibilityText && (
              <p id="err-accessibilityText" className="text-xs text-destructive font-medium" role="alert">
                {errors.accessibilityText}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 7. Required Poster Media */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <CardTitle className="text-sm font-semibold text-foreground">
            7. Required Poster Media
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Mandatory poster image and PDF documents.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="posterImage" isRequired>
              Poster Image (poster.png)
            </Label>
            <input
              id="posterImage"
              ref={posterImageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handlePosterImageChange}
              disabled={isFieldDisabled}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-describedby={errors.posterImage ? 'err-posterImage' : undefined}
              aria-required="true"
            />
            {media.posterImage && (
              <p className="text-xs text-muted-foreground">
                Selected: {media.posterImage.name} ({(media.posterImage.size / (1024 * 1024)).toFixed(2)} MB)
              </p>
            )}
            {errors.posterImage && (
              <p id="err-posterImage" className="text-xs text-destructive font-medium" role="alert">
                {errors.posterImage}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="posterPdf" isRequired>
              Poster PDF (poster.pdf)
            </Label>
            <input
              id="posterPdf"
              ref={posterPdfInputRef}
              type="file"
              accept="application/pdf"
              onChange={handlePosterPdfChange}
              disabled={isFieldDisabled}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-describedby={errors.posterPdf ? 'err-posterPdf' : undefined}
              aria-required="true"
            />
            {media.posterPdf && (
              <p className="text-xs text-muted-foreground">
                Selected: {media.posterPdf.name} ({(media.posterPdf.size / (1024 * 1024)).toFixed(2)} MB)
              </p>
            )}
            {errors.posterPdf && (
              <p id="err-posterPdf" className="text-xs text-destructive font-medium" role="alert">
                {errors.posterPdf}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 8. Snapshot Gallery (Optional, MG-05 Compliant) */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6 border-b border-border">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold text-foreground">
                8. Snapshot Gallery (Optional)
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground">
                Upload up to {MAX_GALLERY_IMAGES} supplementary snapshot images. Each supplied image requires descriptive alt text, explicit content classification, and team-authored full text when text-bearing.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 flex flex-col gap-5">
          {media.galleryImages.slice(0, visibleGalleryCount).map((item) => {
            const pos = item.position;
            const imgErr = errors[`galleryImage_${pos}`];
            const altErr = errors[`galleryAlt_${pos}`];
            const kindErr = errors[`galleryContentKind_${pos}`];
            const fullTextErr = errors[`galleryFullText_${pos}`];

            return (
              <div
                key={`gallery-slot-${pos}`}
                className="p-3.5 rounded-lg border border-border bg-muted/20 flex flex-col gap-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    Snapshot {pos} (snapshot-{pos})
                  </span>
                  {(item.file || item.altText || item.contentKind || item.fullText) && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleClearGalleryItem(pos)}
                      disabled={isFieldDisabled}
                      className="h-7 text-xs px-2 text-destructive hover:text-destructive"
                      aria-label={`Clear snapshot ${pos}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                      Remove
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`galleryImage_${pos}`}>
                      Image file (PNG, JPEG, WEBP)
                    </Label>
                    <input
                      id={`galleryImage_${pos}`}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => handleGalleryFileChange(pos, e)}
                      disabled={isFieldDisabled}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-describedby={imgErr ? `err-snap-${pos}` : undefined}
                    />
                    {item.file && (
                      <p className="text-xs text-muted-foreground">
                        Selected: {item.file.name} ({(item.file.size / (1024 * 1024)).toFixed(2)} MB)
                      </p>
                    )}
                    {imgErr && (
                      <p id={`err-snap-${pos}`} className="text-xs text-destructive font-medium" role="alert">
                        {imgErr}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between items-center">
                      <Label htmlFor={`galleryAlt_${pos}`} isRequired={Boolean(item.file)}>
                        Snapshot {pos} alt text
                      </Label>
                      <span className="text-xs text-muted-foreground">
                        {(item.altText || '').trim().length} / {ACCESSIBLE_CONTENT_LIMITS.snapshotAltText.toLocaleString()}
                      </span>
                    </div>
                    <Input
                      id={`galleryAlt_${pos}`}
                      value={item.altText}
                      onChange={(e) => handleGalleryAltChange(pos, e.target.value)}
                      disabled={isFieldDisabled}
                      placeholder={`Descriptive alt text for snapshot ${pos}`}
                      isInvalid={Boolean(altErr)}
                      aria-describedby={altErr ? `err-alt-${pos}` : undefined}
                      aria-required={Boolean(item.file)}
                    />
                    {altErr && (
                      <p id={`err-alt-${pos}`} className="text-xs text-destructive font-medium" role="alert">
                        {altErr}
                      </p>
                    )}
                  </div>
                </div>

                {/* Classification & Full Text (MG-05 Accessibility Requirement) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-border/50">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`galleryContentKind_${pos}`} isRequired={Boolean(item.file)}>
                      Content classification
                    </Label>
                    <select
                      id={`galleryContentKind_${pos}`}
                      value={item.contentKind}
                      onChange={(e) =>
                        handleGalleryContentKindChange(
                          pos,
                          e.target.value as SnapshotImageContentKind | ''
                        )
                      }
                      disabled={isFieldDisabled}
                      className={cn(
                        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                        kindErr && 'border-destructive focus-visible:ring-destructive'
                      )}
                      aria-describedby={kindErr ? `err-kind-${pos}` : `desc-kind-${pos}`}
                      aria-required={Boolean(item.file)}
                    >
                      <option value="">Select classification…</option>
                      <option value="ordinary">Ordinary image (photograph / diagram with no meaningful text)</option>
                      <option value="text_bearing">Text-bearing image (slide / screenshot / chart requiring full text)</option>
                    </select>
                    <p id={`desc-kind-${pos}`} className="text-xs text-muted-foreground">
                      {item.contentKind === 'ordinary'
                        ? 'Ordinary photo/graphic: alt text satisfies accessibility (no full text allowed).'
                        : item.contentKind === 'text_bearing'
                          ? 'Text-bearing image: team-authored full text equivalent is required.'
                          : 'Required if image is uploaded: choose whether this image carries meaningful text.'}
                    </p>
                    {kindErr && (
                      <p id={`err-kind-${pos}`} className="text-xs text-destructive font-medium" role="alert">
                        {kindErr}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between items-center">
                      <Label
                        htmlFor={`galleryFullText_${pos}`}
                        isRequired={item.contentKind === 'text_bearing'}
                      >
                        Full textual equivalent
                      </Label>
                      {item.contentKind === 'text_bearing' && (
                        <span className="text-xs text-muted-foreground">
                          {(item.fullText || '').trim().length} / {ACCESSIBLE_CONTENT_LIMITS.snapshotFullText.toLocaleString()}
                        </span>
                      )}
                    </div>
                    <Textarea
                      id={`galleryFullText_${pos}`}
                      value={item.fullText}
                      onChange={(e) => handleGalleryFullTextChange(pos, e.target.value)}
                      disabled={isFieldDisabled || item.contentKind !== 'text_bearing'}
                      placeholder={
                        item.contentKind === 'text_bearing'
                          ? `Transcribe all meaningful text visible in snapshot ${pos}…`
                          : item.contentKind === 'ordinary'
                            ? 'Ordinary images must not carry full text.'
                            : 'Select text-bearing classification to provide full text.'
                      }
                      isInvalid={Boolean(fullTextErr)}
                      aria-describedby={fullTextErr ? `err-fulltext-${pos}` : undefined}
                      aria-required={item.contentKind === 'text_bearing'}
                      className="min-h-[70px]"
                    />
                    {fullTextErr && (
                      <p id={`err-fulltext-${pos}`} className="text-xs text-destructive font-medium" role="alert">
                        {fullTextErr}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {visibleGalleryCount < MAX_GALLERY_IMAGES && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setVisibleGalleryCount((prev) => Math.min(prev + 1, MAX_GALLERY_IMAGES))}
                disabled={isFieldDisabled}
              >
                <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
                Add snapshot {visibleGalleryCount + 1}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleResetForm}
          disabled={isFieldDisabled}
        >
          <RotateCcw className="h-4 w-4 mr-1.5" aria-hidden="true" />
          Reset form
        </Button>

        <Button
          type="submit"
          disabled={isFieldDisabled}
          className="bg-primary hover:bg-primary font-semibold shadow-xs hover:shadow-md"
        >
          <FileCheck2 className="h-4 w-4 mr-2" aria-hidden="true" />
          {isMaterializing ? 'Checking project…' : 'Check project and continue'}
        </Button>
      </div>
    </form>
  );
}
