import Link from 'next/link';
import { publicFeedHistoryHref, type PublicFeedHistoryFilters } from '../../projects/publicFeedHistoryQuery';
import { Button } from '../ui/button';

export function PublicFeedHistoryPagination(props: {
  page: number;
  hasNewer: boolean;
  hasOlder: boolean;
  filters?: PublicFeedHistoryFilters;
}) {
  if (!props.hasNewer && !props.hasOlder) return null;
  return (
    <nav aria-label="Public feed history pages" className="flex items-center justify-between gap-3">
      <div>
        {props.hasNewer && (
          <Button asChild variant="outline">
            <Link href={publicFeedHistoryHref(props.page - 1, props.filters)}>Newer versions</Link>
          </Button>
        )}
      </div>
      <span className="text-sm text-muted-foreground">Page {props.page}</span>
      <div>
        {props.hasOlder && (
          <Button asChild variant="outline">
            <Link href={publicFeedHistoryHref(props.page + 1, props.filters)}>Older versions</Link>
          </Button>
        )}
      </div>
    </nav>
  );
}
