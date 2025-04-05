import { SimplePool, Event, Filter } from 'nostr-tools'; // EventTemplate, VerifiedEvent 추가 (필요시)
import { nip19 } from 'nostr-tools';
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import React, { useState, useCallback } from 'react';

interface RelayInfo {
  url: string;
  type: string;
}

const defaultRelays = [
  'wss://relay.damus.io/',
  'wss://hbr.coracle.social/',
  'wss://nos.lol/',
  'wss://purplepag.es/',
  'wss://relay.nostr.band/',
];

const isWriteRelay = (relayInfo: RelayInfo): boolean => {
  return relayInfo.type.includes('Write');
};

const isDoubleRelay = (relayInfo: RelayInfo): boolean => {
  return relayInfo.type === '📖✍️ Read/Write';
};

const isWriteOnlyRelay = (relayInfo: RelayInfo): boolean => {
  return relayInfo.type === '✍️ Write';
};

const isReadOnlyRelay = (relayInfo: RelayInfo): boolean => {
  return relayInfo.type === '📖 Read';
};

type SyncStatus =
  | 'idle'
  | 'fetching_relays'
  | 'fetching_batch'
  | 'syncing_event'
  | 'batch_complete'
  | 'error'
  | 'complete';
interface SyncProgress {
  status: SyncStatus;
  message: string;
  syncedUntilTimestamp?: number;
  currentEventId?: string;
  errorDetails?: string;
}

async function fetchOutboxRelays(
  pubkey: string,
  relays: string[] | null
): Promise<RelayInfo[] | null> {
  const relaysToQuery = relays && relays.length > 0 ? relays : defaultRelays;
  const pool = new SimplePool();
  try {
    const event = await pool.get(relaysToQuery, {
      kinds: [10002],
      authors: [pubkey],
    });

    if (event && event.tags) {
      const relayInfo = event.tags
        .filter((tag: string[]) => tag[0] === 'r')
        .map((tag: string[]) => ({
          url: tag[1],
          type: tag[2]
            ? tag[2] === 'read'
              ? '📖 Read'
              : '✍️ Write'
            : '📖✍️ Read/Write',
        }));
      return relayInfo;
    }
    return null;
  } catch (e) {
    console.error('Outbox relay fetch error:', e);
    return null;
  } finally {
    pool.destroy();
  }
}

// --- syncEvents 수정 ---
async function syncEvents(
  pubkey: string,
  allRelaysInfo: RelayInfo[],
  updateProgress: (progress: SyncProgress) => void
): Promise<boolean> {
  const writeRelayUrls = allRelaysInfo.filter(isWriteRelay).map((r) => r.url);

  if (writeRelayUrls.length === 0) {
    updateProgress({
      status: 'error',
      message: 'Error: No write relays found in NIP-65 list.',
    });
    return false;
  }

  updateProgress({
    status: 'fetching_batch',
    message: `Identified ${writeRelayUrls.length} write relays. Starting sync...`,
  });
  console.log('Starting sync for', pubkey, 'on write relays:', writeRelayUrls);

  // v2 SimplePool 생성 (옵션 확인 필요)
  const syncPool = new SimplePool(/* Pool 옵션 */);
  syncPool.trackRelays = true;
  let syncUntilTimestamp = Math.floor(Date.now() / 1000);
  const batchSize = 3;
  let allSynced = true;
  let totalSyncedCount = 0;

  try {
    while (true) {
      updateProgress({
        status: 'fetching_batch',
        message: `Fetching max ${batchSize} notes before ${new Date(syncUntilTimestamp * 1000).toLocaleString()}... (Total synced: ${totalSyncedCount})`,
        syncedUntilTimestamp: syncUntilTimestamp,
      });

      const filter: Filter = {
        kinds: [1], // Only sync notes
        authors: [pubkey],
        until: syncUntilTimestamp, // Get events strictly older than this timestamp
        limit: batchSize,
      };

      let events: Event[] = [];
      try {
        // --- 여기가 핵심 변경점: list 대신 querySync 사용 ---
        // querySync는 EOSE를 기다린 후 이벤트 배열 반환
        // maxWait 같은 옵션이 있다면 추가 (v2 API 확인)
        console.log(
          `Querying relays ${writeRelayUrls.join(', ')} with filter:`,
          filter
        );
        events = await syncPool.querySync(
          writeRelayUrls,
          filter /*, { maxWait: 15000 } - 옵션 확인 */
        );
        console.log(
          `Fetched ${events.length} events for batch before ${syncUntilTimestamp}`
        );
      } catch (queryError: any) {
        console.error('Error fetching event batch with querySync:', queryError);
        // querySync가 타임아웃 등으로 실패할 수 있음
        updateProgress({
          status: 'error',
          message: `Error fetching event batch: ${queryError.message || queryError}`,
        });
        allSynced = false;
        break;
      }

      // test
      // break;

      if (events.length === 0) {
        updateProgress({
          status: 'complete',
          message: `Sync complete! No more older events found. Total synced: ${totalSyncedCount}`,
        });
        console.log('Sync complete for', pubkey);
        break; // 동기화 완료
      }

      // 최신순 정렬 (querySync 결과 순서가 보장되지 않을 수 있음)
      events.sort((a, b) => b.created_at - a.created_at);

      const batchOldestTimestamp = events[events.length - 1].created_at;

      for (const event of events) {
        // --- 동일 이벤트 재 동기화 방지 (선택적 최적화) ---
        // 만약 특정 릴레이가 다운되어 이전에 실패했다가 다시 시도하는 경우 필요할 수 있지만,
        // 기본적으로는 publish는 멱등적(idempotent)이므로 그냥 발행해도 문제는 없음.
        // const alreadySynced = await checkEventOnAllRelays(syncPool, writeRelayUrls, event.id);
        // if (alreadySynced) continue;
        // ---------------------------------------------

        updateProgress({
          status: 'syncing_event',
          message: `Syncing event ${event.id.substring(0, 8)}... (created: ${new Date(event.created_at * 1000).toLocaleString()})`,
          currentEventId: event.id,
          syncedUntilTimestamp: syncUntilTimestamp, // 어디까지 동기화 시도 중인지 표시
        });
        console.log(
          `Attempting to publish event ${event.id} to ${writeRelayUrls.length} relays.`
        );

        const shownRelay = syncPool.seenOn.get(event.id);
        const shownRelayList = Array.from(shownRelay as Set<AbstractRelay>).map(
          (x) => x.url
        );
        const relayThatDoesNotHaveThisEvent = writeRelayUrls.filter(
          (item) => !shownRelayList.includes(item)
        );

        try {
          // --- publish 사용 (v2 SimplePool의 publish API 확인 필요) ---
          // v2의 publish는 Promise<string>[] 를 반환할 수도 있고, 다른 방식일 수도 있음. 제공된 코드는 Promise<string>[] 형태.
          const publishPromises = syncPool.publish(
            relayThatDoesNotHaveThisEvent,
            event
          );

          // Promise.allSettled 로 모든 결과 확인
          const results = await Promise.allSettled(publishPromises);

          const failedRelays: string[] = [];
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              failedRelays.push(writeRelayUrls[index]);
              console.error(
                `Failed to publish event ${event.id} to relay ${writeRelayUrls[index]}:`,
                result.reason
              );
            } else {
              // 성공 응답 (v2 publish 가 반환하는 값 확인)
              // result.value 가 'ok' 문자열이거나 다른 형태일 수 있음
              console.log(
                `Publish confirmed/sent for event ${event.id} to relay ${writeRelayUrls[index]}: ${result.value}`
              );
            }
          });

          if (failedRelays.length > 0) {
            const errorMsg = `Error: Failed to publish event ${event.id.substring(0, 8)} to ${failedRelays.length} relays: ${failedRelays.join(', ')}. Stopping sync.`;
            updateProgress({
              status: 'error',
              message: errorMsg,
              currentEventId: event.id,
              errorDetails: `Failed relays: ${failedRelays.join(', ')}`,
            });
            console.error(errorMsg);
            allSynced = false;
            break; // 요청대로 즉시 중단
          } else {
            totalSyncedCount++; // 성공적으로 동기화된 이벤트 수 증가
          }
        } catch (publishError: any) {
          const errorMsg = `Unexpected error publishing event ${event.id}: ${publishError.message || publishError}. Stopping sync.`;
          updateProgress({
            status: 'error',
            message: errorMsg,
            currentEventId: event.id,
            errorDetails: `${publishError}`,
          });
          console.error(errorMsg, publishError);
          allSynced = false;
          break;
        }
      } // End of for (const event of events)

      if (!allSynced) {
        break; // 에러 발생 시 외부 루프 종료
      }

      // 다음 배치를 위해 타임스탬프 업데이트
      // 중요: until 필터는 해당 시간 *미만*을 의미하므로, 다음번에는 현재 배치의 가장 오래된 이벤트 시간으로 설정
      syncUntilTimestamp = batchOldestTimestamp;

      updateProgress({
        status: 'batch_complete',
        message: `Batch synced. Continuing before ${new Date(syncUntilTimestamp * 1000).toLocaleString()} (Total synced: ${totalSyncedCount})`,
        syncedUntilTimestamp: syncUntilTimestamp,
      });

      // 릴레이 부하 감소를 위한 짧은 지연 (선택 사항)
      await new Promise((resolve) => setTimeout(resolve, 250));

      // 만약 가져온 이벤트 수가 요청한 batchSize보다 적다면, 거의 끝에 도달했다는 의미
      if (events.length < batchSize) {
        updateProgress({
          status: 'complete',
          message: `Sync complete! Reached end of history. Total synced: ${totalSyncedCount}`,
        });
        console.log(
          'Sync complete for',
          pubkey,
          '- likely reached end of history.'
        );
        break;
      }
    } // End of while(true)
  } catch (error: any) {
    updateProgress({
      status: 'error',
      message: `Unhandled sync error: ${error.message || error}`,
    });
    console.error('Unhandled sync error:', error);
    allSynced = false;
  } finally {
    // SimplePool 자원 정리 (v2 API 확인 필요)
    syncPool.close(writeRelayUrls); // 관련된 모든 릴레이 연결 종료 시도
    // 또는 syncPool.destroy();
  }

  return allSynced;
}

function App() {
  const [input, setInput] = useState('');
  const [decodedHex, setDecodedHex] = useState<string | null>(null);
  const [profileRelays, setProfileRelays] = useState<string[] | null>(null);
  const [outboxRelays, setOutboxRelays] = useState<RelayInfo[] | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    status: 'idle',
    message: 'Enter npub or nprofile and click Decode.',
  });

  const handleDecode = useCallback(async () => {
    setIsDecoding(true);
    setDecodeError(null);
    setDecodedHex(null);
    setProfileRelays(null);
    setOutboxRelays(null);
    setSyncProgress({ status: 'idle', message: 'Decoding...' });

    try {
      const { type, data } = nip19.decode(input.trim());
      let pubkeyHex: string;
      let relaysFromProfile: string[] | null = null;

      if (type === 'npub') {
        pubkeyHex = data as string;
      } else if (type === 'nprofile') {
        pubkeyHex = (data as { pubkey: string; relays?: string[] }).pubkey;
        relaysFromProfile =
          (data as { pubkey: string; relays?: string[] }).relays || null;
      } else {
        setDecodeError(
          'Unsupported NIP-19 format. (Only npub or nprofile supported)'
        );
        setIsDecoding(false);
        setSyncProgress({ status: 'idle', message: 'Decode failed.' });
        return;
      }

      setDecodedHex(pubkeyHex);
      setProfileRelays(relaysFromProfile);
      setSyncProgress({
        status: 'fetching_relays',
        message: 'Fetching NIP-65 relay list...',
      });

      const relayInfo = await fetchOutboxRelays(pubkeyHex, relaysFromProfile);
      if (relayInfo) {
        setOutboxRelays(relayInfo);
        const writeRelaysCount = relayInfo.filter(isWriteRelay).length;
        setSyncProgress({
          status: 'idle',
          message: `Found ${relayInfo.length} relays in NIP-65 (${writeRelaysCount} write). Ready to sync.`,
        });
      } else {
        setSyncProgress({
          status: 'idle',
          message: 'Could not find NIP-65 relay list. Sync disabled.',
        });
        setDecodeError('Failed to fetch NIP-65 relay list (kind:10002)...');
      }
    } catch (e: any) {
      setDecodeError(
        `Decoding failed: ${e.message || 'Invalid NIP-19 string?'}`
      );
      console.error('Decode error:', e);
      setSyncProgress({ status: 'idle', message: 'Decode failed.' });
    } finally {
      setIsDecoding(false);
    }
  }, [input]);

  const handleSync = useCallback(async () => {
    if (!decodedHex || !outboxRelays || isSyncing) return;

    const writeRelays = outboxRelays.filter(isWriteRelay);
    if (writeRelays.length === 0) {
      setSyncProgress({
        status: 'error',
        message: 'No write relays found. Cannot sync.',
      });
      return;
    }
    setIsSyncing(true);
    setSyncProgress({ status: 'fetching_batch', message: 'Starting sync...' });
    const success = await syncEvents(decodedHex, outboxRelays, setSyncProgress);
    setIsSyncing(false);
    if (success && syncProgress.status !== 'complete') {
      setSyncProgress((prev) => ({
        ...prev,
        status: 'complete',
        message: prev.message || 'Sync finished!',
      }));
    } else if (!success && syncProgress.status !== 'error') {
      setSyncProgress((prev) => ({
        ...prev,
        status: 'error',
        message: prev.message || 'Sync stopped or failed unexpectedly.',
      }));
    }
  }, [decodedHex, outboxRelays, isSyncing, syncProgress.status]);

  const doubleRelay = outboxRelays?.filter(isDoubleRelay) || [];
  const writeRelays = outboxRelays?.filter(isWriteRelay) || [];
  const writeOnlyRelays = outboxRelays?.filter(isWriteOnlyRelay) || [];
  const readOnlyRelays = outboxRelays?.filter(isReadOnlyRelay) || [];

  return (
    <div
      style={{
        padding: '2rem',
        fontFamily: 'sans-serif',
        maxWidth: '800px',
        margin: 'auto',
      }}
    >
      <h1>Nostr Event Synchronizer</h1>
      <p>
        Syncs your past notes (kind:1) across all 'write' relays listed in your
        NIP-65 (kind:10002).
      </p>
      <input
        type="text"
        placeholder="npub1... or nprofile1..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={isDecoding || isSyncing}
        style={{
          width: 'calc(100% - 110px)',
          padding: '0.5rem',
          fontSize: '1rem',
          marginRight: '10px',
        }}
      />
      <button
        onClick={handleDecode}
        disabled={isDecoding || isSyncing}
        style={{ padding: '0.5rem 1rem' }}
      >
        {isDecoding ? 'Decoding...' : 'Decode'}
      </button>

      {decodeError && (
        <div style={{ marginTop: '1rem', color: 'red' }}>
          Error: {decodeError}
        </div>
      )}

      {decodedHex && (
        <div style={{ marginTop: '1rem' }}>
          <strong>🔓 HEX pubkey:</strong>
          <pre
            style={{
              background: '#f0f0f0',
              padding: '0.5rem',
              overflowX: 'auto',
            }}
          >
            {decodedHex}
          </pre>
        </div>
      )}

      {profileRelays && profileRelays.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <strong>🌐 Relays from nprofile:</strong>
          <ul
            style={{
              background: '#f8f8f8',
              padding: '1rem',
              listStyle: 'none',
              maxHeight: '100px',
              overflowY: 'auto',
            }}
          >
            {profileRelays.map((relay, idx) => (
              <li key={idx} style={{ wordBreak: 'break-all' }}>
                {relay}
              </li>
            ))}
          </ul>
        </div>
      )}

      {outboxRelays && (
        <div style={{ marginTop: '1rem' }}>
          <strong>📤 NIP-65 Relays:</strong>
          {doubleRelay.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <strong>📖✍️ Read/Write Relay ({doubleRelay.length}):</strong>
              <ul
                style={{
                  background: '#f0f8f0',
                  padding: '1rem',
                  listStyle: 'none',
                  maxHeight: '100px',
                  overflowY: 'auto',
                }}
              >
                {doubleRelay.map((relay, idx) => (
                  <li key={`r-${idx}`} style={{ wordBreak: 'break-all' }}>
                    {relay.url}{' '}
                    <span style={{ color: '#666' }}>({relay.type})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {writeOnlyRelays.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <strong>✍️ Write Only ({writeOnlyRelays.length}):</strong>
              <ul
                style={{
                  background: '#e0f0ff',
                  padding: '1rem',
                  listStyle: 'none',
                  maxHeight: '150px',
                  overflowY: 'auto',
                }}
              >
                {writeOnlyRelays.map((relay, idx) => (
                  <li key={`w-${idx}`} style={{ wordBreak: 'break-all' }}>
                    {relay.url}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {readOnlyRelays.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <strong>📖 Read Only ({readOnlyRelays.length}):</strong>
              <ul
                style={{
                  background: '#f0f8f0',
                  padding: '1rem',
                  listStyle: 'none',
                  maxHeight: '100px',
                  overflowY: 'auto',
                }}
              >
                {readOnlyRelays.map((relay, idx) => (
                  <li key={`r-${idx}`} style={{ wordBreak: 'break-all' }}>
                    {relay.url}{' '}
                    <span style={{ color: '#666' }}>({relay.type})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {writeRelays.length > 0 ? (
            <div
              style={{
                marginTop: '1.5rem',
                border: '1px solid #ccc',
                padding: '1rem',
              }}
            >
              <h3>Sync Status</h3>
              <button
                onClick={handleSync}
                disabled={
                  isSyncing ||
                  writeRelays.length === 0 ||
                  syncProgress.status === 'fetching_relays' ||
                  syncProgress.status === 'fetching_batch' ||
                  syncProgress.status === 'syncing_event'
                }
                style={{ padding: '0.5rem 1rem', marginBottom: '1rem' }}
              >
                {isSyncing ? 'Syncing...' : 'Start Full Sync (kind:1)'}
              </button>
              {/* ... Sync Progress Display ... */}
              <div style={{ minHeight: '4em' /* Prevent layout shifts */ }}>
                <div>
                  <strong>Status:</strong> {syncProgress.message}
                </div>
                {isSyncing && syncProgress.currentEventId && (
                  <div style={{ fontSize: '0.9em', color: '#555' }}>
                    Current Event:{' '}
                    {syncProgress.currentEventId.substring(0, 10)}...
                  </div>
                )}
                {syncProgress.status === 'error' &&
                  syncProgress.errorDetails && (
                    <div style={{ fontSize: '0.9em', color: 'red' }}>
                      Details: {syncProgress.errorDetails}
                    </div>
                  )}
                {syncProgress.status === 'complete' && (
                  <div style={{ color: 'green', fontWeight: 'bold' }}>
                    Synchronization finished successfully!
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ marginTop: '1rem', color: 'orange' }}>
              Warning: No 'write' relays found in NIP-65 list. Sync cannot
              proceed.
            </div>
          )}
        </div>
      )}
      {/* ... (No NIP-65 found message) ... */}
      {!outboxRelays && decodedHex && !isDecoding && !decodeError && (
        <div style={{ marginTop: '1rem', color: 'orange' }}>
          Could not find or fetch NIP-65 relay list (kind:10002). Sync is not
          possible. Ensure the user has published a kind:10002 event to common
          relays.
        </div>
      )}
    </div>
  );
}

export default App;
