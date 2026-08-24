'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  RotateCcw,
} from 'lucide-react';
import { useActionState } from 'react';

import {
  executeFeedRollbackAction,
  type ExecuteFeedRollbackActionState,
} from '../../app/admin/feed-history/[versionNumber]/actions';

import {
  ROLLBACK_ACKNOWLEDGEMENT,
} from '../../projects/localFeedRollbackExecution';

import { Button } from '../ui/button';

interface FeedRollbackExecutionPanelProps {
  versionNumber: number;
  targetVersionId: string;
  preparedBaselineFeedHash: string;
  targetRecordCount: number;
  currentRecordCount: number;
}

const initialState: ExecuteFeedRollbackActionState = {
  status: 'idle',
};

export function FeedRollbackExecutionPanel({
  versionNumber,
  targetVersionId,
  preparedBaselineFeedHash,
  targetRecordCount,
  currentRecordCount,
}: FeedRollbackExecutionPanelProps) {
  const [state, action, pending] = useActionState(
    executeFeedRollbackAction,
    initialState,
  );

  const [acknowledged, setAcknowledged] =
    React.useState(false);

  const operationKey = React.useMemo(
    () => crypto.randomUUID(),
    [],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
        <div className="flex items-start gap-2.5">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />

          <div className="space-y-1 text-xs">
            <p className="font-semibold text-foreground">
              Local rollback execution
            </p>

            <p className="text-muted-foreground">
              This will replace the Local canonical public feed
              with historical version V{versionNumber}.
            </p>

            <p className="text-muted-foreground">
              Current feed: <strong>{currentRecordCount}</strong>{' '}
              records → target:{' '}
              <strong>{targetRecordCount}</strong> records.
            </p>

            <p className="text-muted-foreground">
              Project lifecycle state is not changed by this rollback.
            </p>
          </div>
        </div>
      </div>

      <form action={action} className="space-y-4">
        <input
          type="hidden"
          name="versionNumber"
          value={versionNumber}
        />

        <input
          type="hidden"
          name="targetVersionId"
          value={targetVersionId}
        />

        <input
          type="hidden"
          name="preparedBaselineFeedHash"
          value={preparedBaselineFeedHash}
        />

        <input
          type="hidden"
          name="operationKey"
          value={operationKey}
        />

        <input
          type="hidden"
          name="acknowledgement"
          value={
            acknowledged
              ? ROLLBACK_ACKNOWLEDGEMENT
              : ''
          }
        />

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3.5">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) =>
              setAcknowledged(event.target.checked)
            }
            disabled={pending}
            className="mt-0.5 h-4 w-4"
          />

          <span className="text-xs leading-relaxed text-foreground">
            I acknowledge that this action will replace the Local
            canonical public feed with the selected verified
            historical version.
          </span>
        </label>

        <Button
          type="submit"
          disabled={!acknowledged || pending}
        >
          {pending ? (
            <>
              <LoaderCircle
                className="mr-2 h-4 w-4 animate-spin"
                aria-hidden="true"
              />
              Executing rollback…
            </>
          ) : (
            <>
              <RotateCcw
                className="mr-2 h-4 w-4"
                aria-hidden="true"
              />
              Execute Local rollback
            </>
          )}
        </Button>
      </form>

      {state.status === 'success' && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3.5">
          <div className="flex items-start gap-2.5">
            <CheckCircle2
              className="mt-0.5 h-4 w-4 shrink-0 text-success"
              aria-hidden="true"
            />

            <div>
              <p className="text-sm font-semibold text-foreground">
                Rollback completed
              </p>

              <p className="mt-1 text-xs text-muted-foreground">
                {state.message}
              </p>
            </div>
          </div>
        </div>
      )}

      {state.status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3.5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
              aria-hidden="true"
            />

            <div>
              <p className="text-sm font-semibold text-foreground">
                Rollback rejected
              </p>

              <p className="mt-1 text-xs text-muted-foreground">
                {state.message}
              </p>

              {state.resultCode && (
                <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                  {state.resultCode}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}