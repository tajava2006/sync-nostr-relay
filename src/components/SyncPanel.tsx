

import React, { useMemo } from 'react';
import { RelayInfo, SyncProgress } from './types';
import SyncSection from './SyncSection';
import { isReadRelay, isWriteRelay } from './util';

// SyncPanel 컴포넌트의 Props 타입
interface SyncPanelProps {
  outboxRelays: RelayInfo[] | null;
  decodedHex: string | null;
  // Write Sync 관련 Props
  writeSyncProgress: SyncProgress;
  isWriteSyncing: boolean;
  handleWriteSync: () => void;
  // Read Sync 관련 Props
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
  // useMemo를 사용하여 outboxRelays 변경 시에만 리스트 재생성
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

  // outboxRelays나 decodedHex가 없으면 아무것도 렌더링하지 않음
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
          // 다른 동기화 작업 중에도 버튼 비활성화
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
          // 다른 동기화 작업 중에도 버튼 비활성화
          isSyncing={isWriteSyncing || isReadSyncing}
          onStartSync={handleReadSync}
        />
      </div>
    </div>
  );
}