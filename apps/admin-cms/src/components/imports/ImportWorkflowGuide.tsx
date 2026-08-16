import React from 'react';
import { FileSpreadsheet, Image as ImageIcon, FileText, Folder, CheckCircle2, ChevronDown, ChevronRight, HelpCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';

export interface ImportWorkflowGuideProps {
  currentStep?: 1 | 2 | 3 | 4 | 5;
}

const STEPS = [
  { step: 1, label: 'Prepare files' },
  { step: 2, label: 'Add reference file' },
  { step: 3, label: 'Choose folder' },
  { step: 4, label: 'Check results' },
  { step: 5, label: 'Import' },
] as const;

export function ImportWorkflowGuide({ currentStep = 1 }: ImportWorkflowGuideProps) {
  const [isGuideOpen, setIsGuideOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* 5-Step Process Orientation Bar */}
      <nav aria-label="Import workflow steps" className="bg-card border border-border rounded-lg p-3 sm:p-4 shadow-xs">
        <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
          {STEPS.map(({ step, label }) => {
            const isCurrent = step === currentStep;
            const isCompleted = step < currentStep;
            return (
              <li
                key={step}
                className={`flex items-center gap-2 p-2 rounded-md ${
                  isCurrent
                    ? 'bg-primary/10 text-primary font-semibold border border-primary/20'
                    : isCompleted
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground'
                }`}
                aria-current={isCurrent ? 'step' : undefined}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                    isCurrent
                      ? 'bg-primary text-primary-foreground'
                      : isCompleted
                        ? 'bg-muted text-foreground'
                        : 'bg-muted/60 text-muted-foreground'
                  }`}
                  aria-hidden="true"
                >
                  {isCompleted ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : step}
                </span>
                <span className="truncate">{label}</span>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Before You Start Onboarding & Folder Guide Card */}
      <Card className="bg-card border-border shadow-xs">
        <CardHeader className="py-3 px-4 sm:px-6 cursor-pointer select-none" onClick={() => setIsGuideOpen(!isGuideOpen)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HelpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
              <CardTitle className="text-sm font-semibold text-foreground">
                Before you start: Folder and file preparation guide
              </CardTitle>
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium"
              aria-expanded={isGuideOpen}
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="flex items-start gap-2.5 p-2.5 rounded-md bg-muted/40 border border-border">
                  <FileSpreadsheet className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-foreground block font-mono text-xs">project-details.xlsx</strong>
                    <span>Required metadata spreadsheet containing title, summary, year, program, discipline, group name, and team roster.</span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 p-2.5 rounded-md bg-muted/40 border border-border">
                  <ImageIcon className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-foreground block font-mono text-xs">poster.png</strong>
                    <span>Required poster image (PNG, JPEG, or WEBP; maximum 5 MB).</span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 p-2.5 rounded-md bg-muted/40 border border-border">
                  <FileText className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-foreground block font-mono text-xs">poster.pdf</strong>
                    <span>Required high-resolution poster document (PDF; maximum 20 MB).</span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 p-2.5 rounded-md bg-muted/40 border border-border">
                  <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <strong className="text-foreground block font-mono text-xs">snapshot-1.png <span className="font-normal text-muted-foreground font-sans">(optional)</span></strong>
                    <span>Optional showcase image (max 5 MB). When included, image alt text must be provided in the metadata spreadsheet.</span>
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
                  <p className="text-[11px] mb-2">Select the individual project folder directly.</p>
                  <pre className="font-mono text-[11px] text-foreground bg-background p-2 rounded border border-border overflow-x-auto">
{`project-folder/
  ├── project-details.xlsx
  ├── poster.png
  ├── poster.pdf
  └── snapshot-1.png`}
                  </pre>
                </div>

                <div className="p-3 rounded-md bg-muted/50 border border-border">
                  <div className="flex items-center gap-1.5 font-semibold text-foreground mb-1.5">
                    <Folder className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                    <span>Batch Import (Multiple Projects)</span>
                  </div>
                  <p className="text-[11px] mb-2">Select the parent folder containing one child folder per project.</p>
                  <pre className="font-mono text-[11px] text-foreground bg-background p-2 rounded border border-border overflow-x-auto">
{`batch-folder/
  ├── project-alpha/
  │   ├── project-details.xlsx
  │   ├── poster.png
  │   └── poster.pdf
  └── project-beta/
      ├── project-details.xlsx
      ├── poster.png
      └── poster.pdf`}
                  </pre>
                </div>
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground bg-muted/30 p-2.5 rounded border border-border leading-relaxed">
              <strong>Tip:</strong> The folder name is used to propose the project&apos;s public identifier. Avoid spaces or special characters in folder names.
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
