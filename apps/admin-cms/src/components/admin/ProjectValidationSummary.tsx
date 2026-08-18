import React from 'react';
import { Project } from '../../domain/project';
import { validateProjectForApproval } from '../../validation/projectValidation';
import type { ApprovalMediaInput } from '../../validation/projectValidation';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { PROJECT_DETAIL_SURFACE_CLASSES } from './projectDetailSurfaceStyles';

interface ProjectValidationSummaryProps {
  project: Project;
  approvalMedia: ApprovalMediaInput | null;
}

export function ProjectValidationSummary({ project, approvalMedia }: ProjectValidationSummaryProps) {
  const validation = validateProjectForApproval(project, approvalMedia);

  // Custom staging checks based on the prompt requirements
  const localErrors: string[] = [...validation.errors];
  const localWarnings: string[] = [...validation.warnings];

  // Check invalid layout template
  const allowedTemplates = ['poster_showcase', 'technical_detail', 'media_rich'];
  const templateId = project.layoutConfig?.templateId;
  if (templateId && !allowedTemplates.includes(templateId)) {
    localErrors.push(`[Layout] Invalid layout templateId "${templateId}". Supported: ${allowedTemplates.join(', ')}.`);
  }

  // Missing poster full text and accessibility text are blocking errors, raised by
  // validateProjectForApproval above — they are not quality suggestions and are never listed
  // among the acknowledgeable warnings.

  const isEligible = project.status === 'approved' || project.status === 'published';
  const hasBlockingErrors = localErrors.length > 0;
  const showReadyMessage = isEligible && !hasBlockingErrors;

  return (
    <div className="flex flex-col gap-4">
      <h4 className="text-sm font-semibold text-foreground">Compliance and validation</h4>

      {showReadyMessage && (
        <div className={`flex items-start gap-2.5 p-3.5 ${PROJECT_DETAIL_SURFACE_CLASSES.affirm}`}>
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <div className="text-sm leading-relaxed">
            <span className="block font-semibold">Validation passed</span>
            <span className="text-foreground-subtle">This project has no blocking validation issues.</span>
          </div>
        </div>
      )}

      {!showReadyMessage && isEligible && hasBlockingErrors && (
        <div className={`flex items-start gap-2.5 p-3.5 ${PROJECT_DETAIL_SURFACE_CLASSES.blocker}`}>
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="text-sm leading-relaxed">
            <span className="block font-semibold">Validation needs attention</span>
            <span className="text-foreground-subtle">Project has blocking validation issues that must be addressed.</span>
          </div>
        </div>
      )}

      {/* Errors Section */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <XCircle
            className={`h-4 w-4 shrink-0 ${hasBlockingErrors ? 'text-destructive' : 'text-muted-foreground'}`}
            aria-hidden="true"
          />
          <span>Blocking issues ({localErrors.length})</span>
        </div>
        {localErrors.length === 0 ? (
          <p className="pl-6 text-sm text-muted-foreground">No blocking errors found.</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1.5 pl-10 text-sm text-foreground">
            {localErrors.map((err, i) => (
              <li key={i} className="break-words leading-relaxed marker:text-destructive">
                {err}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Warnings Section */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <AlertTriangle
            className={`h-4 w-4 shrink-0 ${localWarnings.length > 0 ? 'text-warning' : 'text-muted-foreground'}`}
            aria-hidden="true"
          />
          <span>Quality warnings ({localWarnings.length})</span>
        </div>
        {localWarnings.length === 0 ? (
          <p className="pl-6 text-sm text-muted-foreground">No compliance warnings.</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1.5 pl-10 text-sm text-foreground">
            {localWarnings.map((warn, i) => (
              <li key={i} className="break-words leading-relaxed marker:text-warning">
                {warn}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
