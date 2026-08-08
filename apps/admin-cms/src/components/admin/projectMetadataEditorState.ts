import { ProjectMetadataView } from '../../projects/projectMetadata';

export type EditorMode = 'view' | 'edit';

export function isMetadataDirty(initial: ProjectMetadataView, draft: ProjectMetadataView): boolean {
  return initial.title !== draft.title || initial.summary !== draft.summary || initial.background !== draft.background ||
    initial.solution !== draft.solution || initial.year !== draft.year || initial.programId !== draft.programId ||
    initial.disciplineIds.join('|') !== draft.disciplineIds.join('|') || initial.industryCategoryIds.join('|') !== draft.industryCategoryIds.join('|');
}

export function editorCanSubmit(pending: boolean, dirty: boolean): boolean {
  return !pending && dirty;
}
