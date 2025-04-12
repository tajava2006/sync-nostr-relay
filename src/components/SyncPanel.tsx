import React, { useMemo } from 'react';
import { RelayInfo, SyncProgress } from './types';
import SyncSection from './SyncSection';
import { isReadRelay, isWriteRelay } from './util';
import { MAX_READ_RELAYS, MAX_WRITE_RELAYS } from './constant';

interface SyncPanelProps {
  outboxRelays: RelayInfo[] | null;
  decodedHex: string | null;
  writeSyncProgress: SyncProgress;
  isWriteSyncing: boolean;
  handleWriteSync: () => void;
  readSyncProgress: SyncProgress;
  isReadSyncing: boolean;
  handleReadSync: () => void;
}

export function SyncPanel({
  outboxRelays,
  decodedHex,
  writeSyncProgress,
  isWriteSyncing,
  handleWriteSync,
  readSyncProgress,
  isReadSyncing,
  handleReadSync,
}: SyncPanelProps) {
  const writeRelayList = useMemo(
    () => outboxRelays?.filter(isWriteRelay) || [],
    [outboxRelays],
  );
  const readRelayList = useMemo(
    () => outboxRelays?.filter(isReadRelay) || [],
    [outboxRelays],
  );

  const isWriteRelayLimitExceeded = writeRelayList.length > MAX_WRITE_RELAYS;
  const isReadRelayLimitExceeded = readRelayList.length > MAX_READ_RELAYS;

  const canStartWriteSync = !!decodedHex && writeRelayList.length > 0;
  const canStartReadSync = !!decodedHex && readRelayList.length > 0;

  if (!outboxRelays || !decodedHex) {
    return null;
  }

  // Warning message component/logic
  const LimitWarning = () => (
    <div
      style={{
        backgroundColor: '#fff3cd',
        border: '1px solid #ffeeba',
        color: '#856404',
        padding: '0.75rem 1.25rem',
        borderRadius: '0.25rem',
        marginBottom: '1rem',
      }}
    >
      <strong>Relay Limit Notice:</strong> To promote efficient network usage as
      intended by the Outbox Model, syncing is disabled if you have more than{' '}
      {MAX_WRITE_RELAYS} write or {MAX_READ_RELAYS} read relays configured in
      your NIP-65 list.
      <br />
      <small>
        Using too many relays can unnecessarily consume storage, bandwidth, and
        battery for you and others. Consider refining your relay list.
      </small>
    </div>
  );

  return (
    <div>
      <strong>📤 NIP-65 Relays Found:</strong>

      {/* Display warning message if either limit is exceeded */}
      {(isWriteRelayLimitExceeded || isReadRelayLimitExceeded) && (
        <LimitWarning />
      )}

      {/* Two Column Layout for Sync Sections */}
      <div style={{ display: 'flex', marginTop: '1rem', gap: '1rem' }}>
        {/* Write Sync Section */}
        <SyncSection
          title="Write Relay Sync"
          targetRelayUrls={writeRelayList.map((r) => r.url)}
          canStartSync={canStartWriteSync}
          pubkey={decodedHex}
          syncProgress={writeSyncProgress}
          isSyncing={isWriteSyncing || isReadSyncing}
          onStartSync={handleWriteSync}
          isDisabledByLimit={isWriteRelayLimitExceeded}
        />

        {/* Read Sync Section */}
        <SyncSection
          title="Read Relay Sync"
          targetRelayUrls={readRelayList.map((r) => r.url)}
          canStartSync={canStartReadSync}
          pubkey={decodedHex}
          syncProgress={readSyncProgress}
          isSyncing={isWriteSyncing || isReadSyncing}
          onStartSync={handleReadSync}
          isDisabledByLimit={isReadRelayLimitExceeded}
        />
      </div>
    </div>
  );
}
