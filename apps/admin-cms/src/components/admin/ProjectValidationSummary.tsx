import React from 'react';
import { Project } from '../../domain/project';
import { validateProjectForApproval } from '../../validation/projectValidation';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

interface ProjectValidationSummaryProps {
  project: Project;
}

export function ProjectValidationSummary({ project }: ProjectValidationSummaryProps) {
  const validation = validateProjectForApproval(project);

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
    <div className="flex flex-col gap-4 text-xs sm:text-sm">
      {showReadyMessage && (
        <div className="p-3.5 rounded-lg bg-success/10 border border-success/30 text-success text-xs sm:text-sm flex items-start gap-2.5">
          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <span className="font-semibold block">Ready for publication</span>
            <span className="text-muted-foreground text-xs">
              This project record is approved/published and has no blocking validation errors.
            </span>
          </div>
        </div>
      )}

      {!showReadyMessage && isEligible && hasBlockingErrors && (
        <div className="p-3.5 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs sm:text-sm flex items-start gap-2.5">
          <XCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <span className="font-semibold block">Publication blocked</span>
            <span className="text-muted-foreground text-xs">
              Project has approved/published status but fails compliance due to blocking issues below.
            </span>
          </div>
        </div>
      )}

      {/* Errors Section */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
          <span>Blocking issues ({localErrors.length})</span>
        </div>
        {localErrors.length === 0 ? (
          <p className="text-xs text-muted-foreground pl-5">No blocking errors found.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 pl-5 list-disc text-xs text-destructive">
            {localErrors.map((err, i) => (
              <li key={i} className="leading-relaxed">
                {err}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Warnings Section */}
      <div className="flex flex-col gap-2 pt-2 border-t border-border">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
          <span>Quality warnings ({localWarnings.length})</span>
        </div>
        {localWarnings.length === 0 ? (
          <p className="text-xs text-muted-foreground pl-5">No compliance warnings.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 pl-5 list-disc text-xs text-warning">
            {localWarnings.map((warn, i) => (
              <li key={i} className="leading-relaxed">
                {warn}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
