export function pruneStaleSelection(selected: Iterable<string>, selectableIds: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  for (const id of selected) {
    if (selectableIds.has(id)) next.add(id);
  }
  return next;
}
