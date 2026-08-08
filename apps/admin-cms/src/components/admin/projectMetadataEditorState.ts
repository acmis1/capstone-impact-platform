import { ProjectMetadataView } from '../../projects/projectMetadata';

export type EditorMode = 'view' | 'edit';

function sameSelection(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  return left.every((id) => right.includes(id));
}

export function isMetadataDirty(initial: ProjectMetadataView, draft: ProjectMetadataView): boolean {
  return initial.title !== draft.title || initial.summary !== draft.summary || initial.background !== draft.background ||
    initial.solution !== draft.solution || initial.year !== draft.year || initial.programId !== draft.programId ||
    !sameSelection(initial.disciplineIds, draft.disciplineIds) || !sameSelection(initial.industryCategoryIds, draft.industryCategoryIds);
}

export function editorCanSubmit(pending: boolean, dirty: boolean): boolean {
  return !pending && dirty;
}
