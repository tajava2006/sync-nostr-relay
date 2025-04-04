import { SimplePool, Event } from 'nostr-tools';
import { nip19 } from 'nostr-tools';

import { useEffect, useState } from 'react';

interface RelayInfo {
  url: string;
  type: string;
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

function App() {
  const [input, setInput] = useState('');
  const [decodedHex, setDecodedHex] = useState<string | null>(null);
  const [relays, setRelays] = useState<string[] | null>(null);
  const [outboxRelays, setOutboxRelays] = useState<RelayInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        </div>
      )}

      {error && (
        <div style={{ marginTop: '1rem', color: 'red' }}>{error}</div>
      )}
    </div>
  );
}

export default App;