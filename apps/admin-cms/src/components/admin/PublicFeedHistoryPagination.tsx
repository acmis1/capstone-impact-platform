import Link from 'next/link';
import { Button } from '../ui/button';

export function PublicFeedHistoryPagination(props: {
  page: number;
  hasNewer: boolean;
  hasOlder: boolean;
}) {
  if (!props.hasNewer && !props.hasOlder) return null;
  return (
    <nav aria-label="Public feed history pages" className="flex items-center justify-between gap-3">
      <div>
        {props.hasNewer && (
          <Button asChild variant="outline">
            <Link href={`/admin/public-feed?page=${props.page - 1}`}>Newer versions</Link>
          </Button>
        )}
      </div>
      <span className="text-sm text-muted-foreground">Page {props.page}</span>
      <div>
        {props.hasOlder && (
          <Button asChild variant="outline">
            <Link href={`/admin/public-feed?page=${props.page + 1}`}>Older versions</Link>
          </Button>
        )}
      </div>
    </nav>
  );
}
