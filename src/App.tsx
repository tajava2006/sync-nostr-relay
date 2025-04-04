import { SimplePool, Event } from 'nostr-tools';
import { nip19 } from 'nostr-tools';

import { useEffect, useState } from 'react';

interface RelayInfo {
  url: string;
  type: string;
}

interface EventSyncStatus {
  eventId: string;
  presentInRelays: Set<string>;
  created_at: number;
}

interface SyncStatus {
  isSyncing: boolean;
  progress: {
    totalEvents: number;
    syncedEvents: number;
    failedRelays: string[];
  };
}

const defaultRelays = [
  'wss://relay.damus.io/',
  'wss://hbr.coracle.social/',
  'wss://nos.lol/',
  'wss://premium.primal.net/',
  'wss://nostrelites.org/'
];

async function fetchOutboxRelays(pubkey: string, relays: string[] | null): Promise<RelayInfo[] | null> {
  const relaysToQuery = relays && relays.length > 0 ? relays : defaultRelays;
  const pool = new SimplePool();
  try {
    const event = await pool.get(relaysToQuery, {
      kinds: [10002],
      authors: [pubkey]
    });
    
    if (event && event.tags) {
      const relayInfo = event.tags
        .filter((tag: string[]) => tag[0] === 'r')
        .map((tag: string[]) => ({
          url: tag[1],
          type: tag[2] ? (tag[2] === 'read' ? '📖 Read' : '✍️ Write') : '📖✍️ Read/Write'
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

async function syncEvents(pubkey: string, relays: RelayInfo[]): Promise<SyncStatus> {
  const writeRelays = relays.filter(r => r.type.includes('Write'));
  const eventMap = new Map<string, EventSyncStatus>();
  const failedRelays = new Set<string>();

  // 1. 각 쓰기 릴레이에서 최신 이벤트 10개씩 가져오기
  const pool = new SimplePool();
  try {
    for (const relay of writeRelays) {
      try {
        // 최신 10개의 이벤트를 가져오기 위해 since 파라미터를 조정
        const now = Math.floor(Date.now() / 1000);
        const since = now - (7 * 24 * 60 * 60); // 최근 7일
        
        const event = await pool.get([relay.url], {
          kinds: [1], // 텍스트 노트
          authors: [pubkey],
          since: since,
          limit: 10
        });

        if (event) {
          if (!eventMap.has(event.id)) {
            eventMap.set(event.id, {
              eventId: event.id,
              presentInRelays: new Set([relay.url]),
              created_at: event.created_at
            });
          } else {
            eventMap.get(event.id)?.presentInRelays.add(relay.url);
          }
        }
      } catch (e) {
        console.error(`Error fetching events from ${relay.url}:`, e);
        failedRelays.add(relay.url);
      }
    }

    // 2. 이벤트 동기화
    const eventsToSync = Array.from(eventMap.values())
      .sort((a, b) => b.created_at - a.created_at);

    for (const eventStatus of eventsToSync) {
      const missingRelays = writeRelays
        .filter(r => !eventStatus.presentInRelays.has(r.url))
        .filter(r => !failedRelays.has(r.url));

      for (const relay of missingRelays) {
        try {
          // TODO: 이벤트 전송 및 OK 응답 대기 로직 구현
          // 이 부분은 nostr-tools의 publish 메서드를 사용하거나
          // WebSocket 직접 구현이 필요할 수 있습니다
        } catch (e) {
          console.error(`Error syncing event ${eventStatus.eventId} to ${relay.url}:`, e);
          failedRelays.add(relay.url);
        }
      }
    }

    return {
      isSyncing: false,
      progress: {
        totalEvents: eventsToSync.length,
        syncedEvents: eventsToSync.length,
        failedRelays: Array.from(failedRelays)
      }
    };
  } finally {
    pool.destroy();
  }
}

function App() {
  const [input, setInput] = useState('');
  const [decodedHex, setDecodedHex] = useState<string | null>(null);
  const [relays, setRelays] = useState<string[] | null>(null);
  const [outboxRelays, setOutboxRelays] = useState<RelayInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  const handleDecode = async () => {
    try {
      const { type, data } = nip19.decode(input.trim());
      if (type === 'npub') {
        setDecodedHex(data);
        setRelays(null);
        setOutboxRelays(null);
        setError(null);
        
        // Fetch outbox relays for npub
        const relayInfo = await fetchOutboxRelays(data, null);
        setOutboxRelays(relayInfo);
      } else if (type === 'nprofile') {
        setDecodedHex(data.pubkey);
        setRelays(data.relays || []);
        setOutboxRelays(null);
        setError(null);

        // Fetch outbox relays for nprofile
        const relayInfo = await fetchOutboxRelays(data.pubkey, data.relays || null);
        setOutboxRelays(relayInfo);
      } else {
        setError('지원되지 않는 NIP-19 형식입니다. (npub 또는 nprofile만 지원됨)');
        setDecodedHex(null);
        setRelays(null);
        setOutboxRelays(null);
      }
    } catch (e) {
      setError('디코딩에 실패했습니다. 올바른 NIP-19 문자열인지 확인해주세요.');
      setDecodedHex(null);
      setRelays(null);
      setOutboxRelays(null);
    }
  };

  const handleSync = async () => {
    if (!decodedHex || !outboxRelays) return;
    
    setSyncStatus({ isSyncing: true, progress: { totalEvents: 0, syncedEvents: 0, failedRelays: [] } });
    const status = await syncEvents(decodedHex, outboxRelays);
    setSyncStatus(status);
  };

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h2>NIP-19 디코더</h2>
      <input
        type="text"
        placeholder="npub1... 또는 nprofile1..."
        value={input}
        onChange={e => setInput(e.target.value)}
        style={{ width: '100%', padding: '0.5rem', fontSize: '1rem' }}
      />
      <button onClick={handleDecode} style={{ marginTop: '1rem', padding: '0.5rem 1rem' }}>
        디코딩
      </button>

      {decodedHex && (
        <div style={{ marginTop: '1rem' }}>
          <strong>🔓 HEX pubkey:</strong>
          <pre style={{ background: '#f0f0f0', padding: '1rem' }}>{decodedHex}</pre>
        </div>
      )}

      {relays && relays.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <strong>🌐 Relays:</strong>
          <ul style={{ background: '#f8f8f8', padding: '1rem' }}>
            {relays.map((relay, idx) => (
              <li key={idx}>{relay}</li>
            ))}
          </ul>
        </div>
      )}

      {outboxRelays && outboxRelays.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <strong>📤 Outbox Relays (from kind:10002):</strong>
          <ul style={{ background: '#f0f8ff', padding: '1rem' }}>
            {outboxRelays.map((relay, idx) => (
              <li key={idx}>
                {relay.url} <span style={{ color: '#666' }}>({relay.type})</span>
              </li>
            ))}
          </ul>
          <button 
            onClick={handleSync} 
            style={{ marginTop: '1rem', padding: '0.5rem 1rem' }}
            disabled={syncStatus?.isSyncing}
          >
            {syncStatus?.isSyncing ? '동기화 중...' : '동기화 시작'}
          </button>
        </div>
      )}

      {syncStatus && (
        <div style={{ marginTop: '1rem' }}>
          <strong>🔄 동기화 상태:</strong>
          <ul style={{ background: '#f8f8f8', padding: '1rem' }}>
            <li>총 이벤트: {syncStatus.progress.totalEvents}</li>
            <li>동기화 완료: {syncStatus.progress.syncedEvents}</li>
            {syncStatus.progress.failedRelays.length > 0 && (
              <li>실패한 릴레이:
                <ul>
                  {syncStatus.progress.failedRelays.map((relay, idx) => (
                    <li key={idx}>{relay}</li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </div>
      )}

      {error && (
        <div style={{ marginTop: '1rem', color: 'red' }}>{error}</div>
      )}
    </div>
  );
}

export default App;