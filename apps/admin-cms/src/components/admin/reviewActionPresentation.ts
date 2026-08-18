import type { ButtonProps } from '../ui/button';

type ReviewActionButtonVariant = NonNullable<ButtonProps['variant']>;

export interface ReviewActionPresentation {
  label: string;
  variant: ReviewActionButtonVariant;
  className?: string;
}

export const REVIEW_ACTION_PRESENTATIONS: Record<string, ReviewActionPresentation> = {
  approve: {
    label: 'Approve project',
    variant: 'default',
  },
  request_changes: {
    label: 'Request changes',
    variant: 'outline',
    className:
      'border-warning bg-card text-warning-strong hover:border-warning-strong hover:bg-warning/10 hover:text-warning-strong focus-visible:ring-warning',
  },
  archive: {
    label: 'Archive project',
    variant: 'destructive',
  },
};

export function getReviewActionPresentation(action: string): ReviewActionPresentation {
  return REVIEW_ACTION_PRESENTATIONS[action] ?? {
    label: action.replace('_', ' '),
    variant: 'outline',
  };
}
