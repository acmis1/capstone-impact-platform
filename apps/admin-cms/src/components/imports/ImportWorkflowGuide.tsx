import React from 'react';
import { FileSpreadsheet, Image as ImageIcon, FileText, Folder, ChevronDown, ChevronRight, HelpCircle, Check } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  STRUCTURAL_SURFACE_CLASS_NAME,
} from '../ui/card';
import {
  IMPORT_WORKFLOW_STEP_ITEM_CLASSES,
  IMPORT_WORKFLOW_STEP_MARKER_CLASSES,
} from './importWorkflowStepStyles';

export interface ImportWorkflowGuideProps {
  currentStep?: 1 | 2 | 3 | 4 | 5;
  /** True once the entire workflow (including media import) has finished. */
  isComplete?: boolean;
}

const STEPS = [
  { step: 1, label: 'School spreadsheet' },
  { step: 2, label: 'Project folder' },
  // Step 3 is current *before and while* the file check runs; once validation
  // results exist the workflow has already advanced to the confirmation stage.
  { step: 3, label: 'Check files' },
  { step: 4, label: 'Confirm & save' },
  { step: 5, label: 'Import media' },
] as const;

export function ImportWorkflowGuide({ currentStep = 1, isComplete = false }: ImportWorkflowGuideProps) {
  const [isGuideOpen, setIsGuideOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* 5-Step Process Orientation Bar */}
      <nav
        aria-label="Import workflow steps"
        className={`${STRUCTURAL_SURFACE_CLASS_NAME} p-3 sm:p-4`}
      >
        <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
          {STEPS.map(({ step, label }) => {
            const isCompleted = step < currentStep || (isComplete && step <= currentStep);
            const isCurrent = !isComplete && step === currentStep;
            return (
              <li
                key={step}
                className={`flex items-center gap-2 p-2 rounded-md transition-colors ${
                  isCurrent
                    ? IMPORT_WORKFLOW_STEP_ITEM_CLASSES.current
                    : isCompleted
                      ? IMPORT_WORKFLOW_STEP_ITEM_CLASSES.completed
                      : IMPORT_WORKFLOW_STEP_ITEM_CLASSES.upcoming
                }`}
                aria-current={isCurrent ? 'step' : undefined}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    isCurrent
                      ? IMPORT_WORKFLOW_STEP_MARKER_CLASSES.current
                      : isCompleted
                        ? IMPORT_WORKFLOW_STEP_MARKER_CLASSES.completed
                        : IMPORT_WORKFLOW_STEP_MARKER_CLASSES.upcoming
                  }`}
                  aria-hidden="true"
                >
                  {isCompleted ? <Check className="h-3 w-3" strokeWidth={3} /> : step}
                </span>
                {/* Essential orientation label: never truncated — it wraps instead, so the
                    full stage name stays readable at narrow widths and at 200% zoom. */}
                <span className="min-w-0 whitespace-normal break-words leading-tight">
                  {label}
                  {isCompleted && <span className="sr-only"> (completed)</span>}
                  {isCurrent && <span className="sr-only"> (current step)</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Before You Start Onboarding & Folder Guide Card */}
      <Card className="border-border-structural">
        <CardHeader className="py-3 px-4 sm:px-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HelpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
              <CardTitle className="text-sm font-semibold text-foreground">
                Before you start: Folder and file preparation guide
              </CardTitle>
            </div>
            <button
              type="button"
              onClick={() => setIsGuideOpen((prev) => !prev)}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-md px-2 min-h-[40px]"
              aria-expanded={isGuideOpen}
              aria-label={isGuideOpen ? 'Hide folder and file preparation guide' : 'Show folder and file preparation guide'}
            >
              <span>{isGuideOpen ? 'Hide guide' : 'Show guide'}</span>
              {isGuideOpen ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <CardDescription className="text-xs text-muted-foreground mt-0.5">
            How to format project folders and spreadsheets before importing.
          </CardDescription>
        </CardHeader>

        {isGuideOpen && (
          <CardContent className="pt-2 pb-5 px-4 sm:px-6 border-t border-border flex flex-col gap-5 text-xs text-muted-foreground">
            {/* Required vs Optional Files Table */}
            <div>
              <h4 className="font-semibold text-foreground text-xs uppercase tracking-wider mb-2">
                Expected Files per Project
              </h4>
              <div className="flex flex-col divide-y divide-border rounded-md bg-muted/30 border border-border">
                <div className="flex items-start gap-2.5 p-2.5">
                  <FileSpreadsheet className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-foreground block font-mono text-xs">
                      project-details.xlsx
                    </strong>
                    <span>
                      Required metadata spreadsheet containing title, summary, year, program, discipline, group name, and team roster.
                    </span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 p-2.5">
                  <ImageIcon className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-foreground block font-mono text-xs">poster.png</strong>
                    <span>Required poster image (PNG; maximum 5 MB).</span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 p-2.5">
                  <FileText className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-foreground block font-mono text-xs">poster.pdf</strong>
                    <span>Required high-resolution poster document (PDF; maximum 20 MB).</span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 p-2.5">
                  <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-foreground block font-mono text-xs">
                      snapshot-1 … snapshot-10{' '}
                      <span className="font-normal text-muted-foreground font-sans">
                        (optional)
                      </span>
                    </strong>
                    <span>
                      Optional ordered gallery images, up to 10 total (PNG/JPEG/WebP; maximum 5 MB each).
                      Every included snapshot must have matching alt text for its numeric gallery position in the metadata spreadsheet.
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Folder Structure Layout Examples */}
            <div>
              <h4 className="font-semibold text-foreground text-xs uppercase tracking-wider mb-2">
                Folder Structure
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-3 rounded-md bg-muted/50 border border-border">
                  <div className="flex items-center gap-1.5 font-semibold text-foreground mb-1.5">
                    <Folder className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                    <span>Single Project Import</span>
                  </div>
                  <p className="text-xs mb-2">Select the individual project folder directly.</p>
                  <pre className="font-mono text-[11px] text-foreground bg-background p-2 rounded border border-border overflow-x-auto">
{`project-folder/
  ├── project-details.xlsx
  ├── poster.png
  ├── poster.pdf
  ├── snapshot-1.png
  ├── snapshot-2.png
  └── snapshot-N.png`}
                  </pre>
                </div>

                <div className="p-3 rounded-md bg-muted/50 border border-border">
                  <div className="flex items-center gap-1.5 font-semibold text-foreground mb-1.5">
                    <Folder className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                    <span>Batch Import (Multiple Projects)</span>
                  </div>
                  <p className="text-xs mb-2">Select the parent folder containing one child folder per project.</p>
                  <pre className="font-mono text-[11px] text-foreground bg-background p-2 rounded border border-border overflow-x-auto">
{`batch-folder/
  ├── project-alpha/
  │   ├── project-details.xlsx
  │   ├── poster.png
  │   ├── poster.pdf
  │   ├── snapshot-1.png
  │   └── snapshot-2.png
  └── project-beta/
      ├── project-details.xlsx
      ├── poster.png
      └── poster.pdf`}
                  </pre>
                </div>
              </div>
            </div>

            <div className="text-xs text-muted-foreground bg-muted/30 p-2.5 rounded border border-border leading-relaxed">
              <strong>Tip:</strong> The folder name is used to propose the project&apos;s public identifier. Avoid spaces or special characters in folder names.
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
