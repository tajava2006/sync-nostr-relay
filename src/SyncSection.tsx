import { Filter } from "nostr-tools";
import { SyncProgress } from "./App";

// --- Reusable Sync Section Component ---
interface SyncSectionProps {
  title: string;
  targetRelayUrls: string[];
  filterToSync: Filter | null; // Allow null if not ready
  pubkey: string | null;       // Pubkey needed for filter/logging
  syncProgress: SyncProgress;
  isSyncing: boolean;
  onStartSync: () => void;   // Callback to start the sync
}

function SyncSection({
  title,
  targetRelayUrls,
  filterToSync,
  pubkey,
  syncProgress,
  isSyncing,
  onStartSync,
}: SyncSectionProps) {

  const handleButtonClick = () => {
    if (pubkey && filterToSync) {
      onStartSync();
    } else {
      alert("Cannot start sync: Pubkey or filter not ready.");
    }
  };

  return (
    <div style={{ flex: 1, border: '1px solid #ccc', padding: '1rem', margin: '0.5rem', display: 'flex', flexDirection: 'column' }}>
      <h3>{title} ({targetRelayUrls.length} Relays)</h3>

      {/* Display Target Relay List */}
      {targetRelayUrls.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <strong>Target Relays:</strong>
          <ul style={{
            background: '#f9f9f9',
            padding: '0.5rem 1rem',
            listStyle: 'none',
            margin: '0.5rem 0',
            // maxHeight: '80px', // 스크롤 관련 속성 제거
            // overflowY: 'auto',  // 스크롤 관련 속성 제거
            fontSize: '0.9em',
            border: '1px solid #eee'
          }}>
            {targetRelayUrls.map((url, idx) => (
              <li key={idx} style={{ wordBreak: 'break-all' }}>{url}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Sync Button */}
      <button
        onClick={handleButtonClick}
        disabled={
          isSyncing ||
          targetRelayUrls.length === 0 ||
          !filterToSync ||
          !pubkey ||
          syncProgress.status === 'fetching_batch' ||
          syncProgress.status === 'syncing_event'
        }
        style={{ padding: '0.5rem 1rem', marginBottom: '1rem', alignSelf: 'flex-start' }} // Button alignment
      >
        {isSyncing ? 'Syncing...' : `Start ${title}`}
      </button>

      {/* Progress Display Area */}
      <div style={{ minHeight: '6em', marginTop: 'auto' }}> {/* Push progress down */}
        <div>
          <strong>Status:</strong> {syncProgress.message}
        </div>
        {syncProgress.syncedUntilTimestamp && (
          <div style={{ fontSize: '0.9em', color: '#555' }}>
            Processed events before:{' '}
            {new Date(syncProgress.syncedUntilTimestamp * 1000).toLocaleString()}
          </div>
        )}
        {isSyncing && syncProgress.currentEventId && (
          <div style={{ fontSize: '0.9em', color: '#555' }}>
            Current Event:{' '}
            {syncProgress.currentEventId.substring(0, 10)}...
          </div>
        )}
        {syncProgress.status === 'error' && syncProgress.errorDetails && (
          <div style={{ fontSize: '0.9em', color: 'red', marginTop: '0.5em', wordBreak: 'break-word' }}>
            <strong>Details:</strong> {syncProgress.errorDetails}
          </div>
        )}
        {syncProgress.status === 'complete' && (
          <div style={{ color: 'green', fontWeight: 'bold', marginTop: '0.5em' }}>
            Synchronization finished!
          </div>
        )}
      </div>
    </div>
  );
}

export default SyncSection;