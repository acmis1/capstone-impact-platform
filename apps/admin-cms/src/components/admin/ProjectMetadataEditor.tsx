import type { MetadataOption, ProjectMetadataActionResult, ProjectMetadataView } from '../../projects/projectMetadata';
import { PARTICIPANT_CONTENT_OWNERSHIP_MESSAGE } from '../../projects/contentOwnership';

interface Props {
  initialMetadata: ProjectMetadataView;
  programs: MetadataOption[];
  disciplines: MetadataOption[];
  industryCategories: MetadataOption[];
  canEdit: boolean;
  projectStatus: string;
  saveAction: (input: unknown) => Promise<ProjectMetadataActionResult>;
  headingLevel?: 'h2' | 'h3' | 'h4';
}

/** Staff inspect the participant's package; corrections must come from a new package. */
export function ProjectMetadataEditor({ headingLevel: Heading = 'h2' }: Props) {
  return (
    <section aria-labelledby="metadata-editor-title">
      <Heading id="metadata-editor-title" className="text-base font-semibold tracking-tight text-foreground">
        Project information
      </Heading>
      <p className="mt-2 max-w-[72ch] text-sm leading-relaxed text-muted-foreground">
        {PARTICIPANT_CONTENT_OWNERSHIP_MESSAGE}
      </p>
    </section>
  );
}
