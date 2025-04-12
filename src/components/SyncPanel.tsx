import React, { useMemo } from 'react';
import { RelayInfo, SyncProgress } from './types';
import SyncSection from './SyncSection';
import { isReadRelay, isWriteRelay } from './util';

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

  const canStartWriteSync = !!decodedHex && writeRelayList.length > 0;
  const canStartReadSync = !!decodedHex && readRelayList.length > 0;

  if (!outboxRelays || !decodedHex) {
    return null;
  }

  return (
    <div>
      <strong>📤 NIP-65 Relays Found:</strong>
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
        />
      </div>
    </div>
  );
}
