export interface LocalArchiveState { reason: string; acknowledged: boolean; pending: boolean; error: string | null; success: 'COMPLETED' | 'ALREADY_COMPLETED' | null }
export const initialLocalArchiveState: LocalArchiveState = { reason: '', acknowledged: false, pending: false, error: null, success: null };
export type LocalArchiveEvent = { type: 'REASON'; reason: string } | { type: 'ACK'; value: boolean } | { type: 'START' } | { type: 'SUCCESS'; resultCode: 'COMPLETED' | 'ALREADY_COMPLETED' } | { type: 'FAIL'; error: string };
export function localArchiveReducer(state: LocalArchiveState, event: LocalArchiveEvent): LocalArchiveState {
  switch (event.type) {
    case 'REASON': return { ...state, reason: event.reason };
    case 'ACK': return { ...state, acknowledged: event.value };
    case 'START': return { ...state, pending: true, error: null };
    case 'SUCCESS': return { ...state, pending: false, acknowledged: false, error: null, success: event.resultCode };
    case 'FAIL': return { ...state, pending: false, error: event.error };
  }
}
export function canExecuteLocalArchive(state: LocalArchiveState): boolean { return !state.pending && !state.success && state.acknowledged && state.reason.trim().length > 0 && state.reason.trim().length <= 4000; }
