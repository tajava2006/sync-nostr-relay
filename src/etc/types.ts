export interface RelayInfo {
  url: string;
  type: string;
}

// Define possible statuses for the sync process
type SyncStatus =
  | 'idle'
  | 'fetching_relays'
  | 'fetching_batch'
  | 'syncing_event'
  | 'batch_complete'
  | 'error'
  | 'complete';

// Interface for the sync progress state object
export interface SyncProgress {
  status: SyncStatus;
  message: string;
  syncedUntilTimestamp?: number; // Timestamp until which events have been processed
  stopAtTimestamp?: number; // 사용자가 설정한 동기화 종료 시점 (선택적)
  currentEventId?: string; // ID of the event currently being synced
  errorDetails?: string; // Specific reason for an error
}
