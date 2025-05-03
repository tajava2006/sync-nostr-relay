import { SyncProgress } from '../etc/types';

interface SyncSectionProps {
  title: string;
  targetRelayUrls: string[];
  canStartSync: boolean;
  pubkey: string | null;
  syncProgress: SyncProgress;
  isSyncing: boolean;
  onStartSync: () => void;
  isDisabledByLimit: boolean;
}

function SyncSection({
  title,
  targetRelayUrls,
  canStartSync,
  pubkey,
  syncProgress,
  isSyncing,
  onStartSync,
  isDisabledByLimit,
}: SyncSectionProps) {
  const handleButtonClick = () => {
    onStartSync();
  };

  return (
    <div
      style={{
        flex: 1,
        border: '1px solid #ccc',
        padding: '1rem',
        margin: '0.5rem',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <h3>
        {title} ({targetRelayUrls.length} Relays)
      </h3>

      {/* Display Target Relay List */}
      {targetRelayUrls.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <strong>Target Relays:</strong>
          <ul
            style={{
              background: '#f9f9f9',
              padding: '0.5rem 1rem',
              listStyle: 'none',
              margin: '0.5rem 0',
              fontSize: '0.9em',
              border: '1px solid #eee',
            }}
          >
            {targetRelayUrls.map((url, idx) => (
              <li key={idx} style={{ wordBreak: 'break-all' }}>
                {url}
              </li>
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
          !canStartSync ||
          !pubkey ||
          isDisabledByLimit ||
          syncProgress.status === 'fetching_batch' ||
          syncProgress.status === 'syncing_event'
        }
        style={{
          padding: '0.5rem 1rem',
          marginBottom: '1rem',
          alignSelf: 'flex-start',
        }} // Button alignment
      >
        {isDisabledByLimit
          ? 'Too Many Relays'
          : isSyncing
            ? 'Syncing...'
            : `Start ${title}`}
      </button>

      {/* Progress Display Area */}
      <div style={{ minHeight: '6em', marginTop: 'auto' }}>
        {' '}
        {/* Push progress down */}
        <div>
          <strong>Status:</strong> {syncProgress.message}
        </div>
        {syncProgress.syncedUntilTimestamp && (
          <div style={{ fontSize: '0.9em', color: '#555' }}>
            Processed events before:{' '}
            {new Date(
              syncProgress.syncedUntilTimestamp * 1000,
            ).toLocaleString()}
          </div>
        )}
        {isSyncing && syncProgress.currentEventId && (
          <div style={{ fontSize: '0.9em', color: '#555' }}>
            Current Event: {syncProgress.currentEventId.substring(0, 10)}...
          </div>
        )}
        {syncProgress.status === 'error' && syncProgress.errorDetails && (
          <div
            style={{
              fontSize: '0.9em',
              color: 'red',
              marginTop: '0.5em',
              wordBreak: 'break-word',
            }}
          >
            <strong>Details:</strong> {syncProgress.errorDetails}
          </div>
        )}
        {syncProgress.status === 'complete' && (
          <div
            style={{ color: 'green', fontWeight: 'bold', marginTop: '0.5em' }}
          >
            Synchronization finished!
          </div>
        )}
      </div>
    </div>
  );
}

export default SyncSection;
