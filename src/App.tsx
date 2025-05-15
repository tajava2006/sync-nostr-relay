import { nip19 } from 'nostr-tools';
import { useState, useCallback, useEffect } from 'react';
import type { RelayInfo, SyncProgress } from './etc/types';
import {
  fetchOutboxRelays,
  isReadRelay,
  isWriteRelay,
  syncEvents,
} from './etc/util';
import { InputSection } from './components/InputSection';
import { DecodedInfoSection } from './components/DecodedInfoSection';
import NDK, {
  NDKNip07Signer,
  NDKUser,
  NDKRelay,
  type NDKFilter,
} from '@nostr-dev-kit/ndk';
import {
  DEFAULT_OLDEST_DATE_STR,
  DEFAULT_RELAYS,
  getDefaultStartDateStr,
  MAX_READ_RELAYS,
  MAX_WRITE_RELAYS,
} from './etc/constant';
import SyncSection from './components/SyncSection';
import { init } from 'nostr-login';

// Create NDK instance (outside component)
const ndk = new NDK({
  explicitRelayUrls: DEFAULT_RELAYS,
  enableOutboxModel: true,
  autoFetchUserMutelist: false,
  autoConnectUserRelays: true,
});

// Define the authentication policy function
// This function is called for *each relay* when an AUTH challenge is received.
// It should decide whether to authenticate and return true/false.
// NDK will then handle calling the signer if it returns true.
const autoAuthPolicy = async (relay: NDKRelay, challenge: string) => {
  console.log(`AUTH challenge received from ${relay.url}:`, challenge);

  // --- Your Logic Here ---
  // Decide if you want to automatically sign the challenge for this relay.
  // For example:
  // 1. Always attempt to authenticate if a signer is present:
  const shouldAuth = !!ndk.signer; // Authenticate if we have a signer

  // 2. Or, authenticate only for specific relays:
  // const trustedAuthRelays = ['wss://your-trusted-relay.com'];
  // const shouldAuth = !!ndk.signer && trustedAuthRelays.includes(relay.url);

  // 3. Or, maybe prompt the user here if not using NIP-07 (less common for auto-auth)

  if (shouldAuth) {
    console.log(
      `Policy decides to authenticate with ${relay.url}. NDK will use the signer.`,
    );
    return true; // Tell NDK to proceed with authentication using ndk.signer
  } else {
    console.log(`Policy decides *not* to authenticate with ${relay.url}.`);
    return false; // Tell NDK *not* to authenticate
  }
};
// --- Configure NDK with the Auth Policy ---
// Option A: Set a default policy for all relays managed by NDK
ndk.relayAuthDefaultPolicy = autoAuthPolicy;

// Main React App component
function App() {
  // State for user input (npub/nprofile)
  const [input, setInput] = useState('');
  // State for the decoded hex public key
  const [decodedHex, setDecodedHex] = useState<string | null>(null);
  // State for relays found in nprofile (if any)
  const [profileRelays, setProfileRelays] = useState<string[] | null>(null);
  // State for the parsed NIP-65 relay list
  const [outboxRelays, setOutboxRelays] = useState<RelayInfo[] | null>(null);
  // State for decoding errors
  const [decodeError, setDecodeError] = useState<string | null>(null);
  // State to track if decoding is in progress
  const [isDecoding, setIsDecoding] = useState(false);

  // Separate state for Write Sync
  const [isWriteSyncing, setIsWriteSyncing] = useState(false);
  const [writeSyncProgress, setWriteSyncProgress] = useState<SyncProgress>({
    status: 'idle',
    message: 'Ready.',
  });

  // Separate state for Read Sync
  const [isReadSyncing, setIsReadSyncing] = useState(false);
  const [readSyncProgress, setReadSyncProgress] = useState<SyncProgress>({
    status: 'idle',
    message: 'Ready.',
  });

  const now = getDefaultStartDateStr();
  const [writeStartDate, setWriteStartDate] = useState<string>(now);
  const [writeEndDate, setWriteEndDate] = useState<string>(
    DEFAULT_OLDEST_DATE_STR,
  );
  const [readStartDate, setReadStartDate] = useState<string>(now);
  const [readEndDate, setReadEndDate] = useState<string>(
    DEFAULT_OLDEST_DATE_STR,
  );

  const [loggedInUser, setLoggedInUser] = useState<NDKUser | null>(null);

  useEffect(() => {
    ndk
      .connect()
      .then(() => console.log('NDK Connected!'))
      .catch((err) => console.error('NDK Connection Error:', err));
  }, []);

  // Handler for the Decode button click
  const handleDecode = useCallback(async () => {
    setIsDecoding(true);
    setDecodeError(null);
    setDecodedHex(null);
    setProfileRelays(null);
    setOutboxRelays(null);
    // Reset both sync progresses on new decode
    setWriteSyncProgress({ status: 'idle', message: 'Ready.' });
    setReadSyncProgress({ status: 'idle', message: 'Ready.' });

    try {
      // Decode the input string
      const { type, data } = nip19.decode(input.trim());
      let pubkeyHex: string;
      let relaysFromProfile: string[] | null = null;

      // Extract pubkey and profile relays based on type
      if (type === 'npub') {
        pubkeyHex = data as string;
      } else if (type === 'nprofile') {
        pubkeyHex = (data as { pubkey: string; relays?: string[] }).pubkey;
        relaysFromProfile =
          (data as { pubkey: string; relays?: string[] }).relays || null;
      } else {
        throw new Error(
          'Unsupported NIP-19 format. (Only npub or nprofile supported)',
        );
      }

      setDecodedHex(pubkeyHex);
      setProfileRelays(relaysFromProfile);
      // Indicate fetching NIP-65
      setWriteSyncProgress((prev) => ({
        ...prev,
        status: 'fetching_relays',
        message: 'Fetching NIP-65...',
      }));
      setReadSyncProgress((prev) => ({
        ...prev,
        status: 'fetching_relays',
        message: 'Fetching NIP-65...',
      }));

      // Fetch the NIP-65 relay list
      const relayInfo = await fetchOutboxRelays(
        ndk,
        pubkeyHex,
        relaysFromProfile,
      );
      if (relayInfo) {
        setOutboxRelays(relayInfo);
        const writeCount = relayInfo.filter(isWriteRelay).length;
        const readCount = relayInfo.filter(isReadRelay).length;
        const message = `Found ${relayInfo.length} NIP-65 relays (${writeCount} write, ${readCount} read). Ready.`;
        setWriteSyncProgress({ status: 'idle', message });
        setReadSyncProgress({ status: 'idle', message });
      } else {
        const message = 'Could not find NIP-65 list. Sync disabled.';
        setWriteSyncProgress({ status: 'idle', message });
        setReadSyncProgress({ status: 'idle', message });
        setDecodeError(
          'Could not find or fetch NIP-65 relay list (kind:10002).',
        );
      }
    } catch (e: unknown) {
      if (e instanceof Error) {
        setDecodeError(
          `Decoding failed: ${e.message || 'Invalid NIP-19 string?'}`,
        );
      } else {
        setDecodeError('Decoding failed: Unknown error');
      }
      setWriteSyncProgress({ status: 'idle', message: 'Decode failed.' });
      setReadSyncProgress({ status: 'idle', message: 'Decode failed.' });
    } finally {
      setIsDecoding(false);
    }
  }, [input]); // Dependency: input state

  // Handler for the Sync button click
  const handleWriteSync = useCallback(async () => {
    if (!decodedHex || !outboxRelays || isWriteSyncing || isReadSyncing) return; // Prevent concurrent syncs

    const targetWriteRelays = outboxRelays
      .filter(isWriteRelay)
      .map((r) => r.url);
    if (targetWriteRelays.length === 0) {
      setWriteSyncProgress({
        status: 'error',
        message: 'No write relays to sync.',
      });
      return;
    }

    setIsWriteSyncing(true);
    // --- Determine initialUntil (Start Point) and stopAt (End Point) ---
    let initialUntil: number;
    const stopAt = Math.floor(new Date(writeEndDate).getTime() / 1000); // stopAt is always from writeEndDate (Oldest)

    const canResume =
      writeSyncProgress.syncedUntilTimestamp &&
      writeSyncProgress.status === 'error';

    if (canResume) {
      // RESUME: Previous sync was interrupted AND user hasn't changed the StartDate (Newest)
      initialUntil = writeSyncProgress.syncedUntilTimestamp!; // Start from where it left off
      console.log(
        `Resuming write sync from timestamp: ${new Date(initialUntil * 1000).toLocaleString()}`,
      );
    } else {
      // START FRESH/RESTART: User changed StartDate, or it's the first run, or completed run
      initialUntil = Math.floor(new Date(writeStartDate).getTime() / 1000); // Use the selected StartDate (Newest)
      // Clear previous resume point when not resuming
      setWriteSyncProgress((prev) => ({
        ...prev,
        syncedUntilTimestamp: undefined,
      }));
    }
    // --- End timestamp determination --
    const filter: NDKFilter = { kinds: [1, 6, 30023], authors: [decodedHex] };

    const updateWriteProgress = (progress: SyncProgress) => {
      setWriteSyncProgress((prev) => ({
        ...prev,
        ...progress,
        stopAtTimestamp: stopAt,
      }));
    };

    const success = await syncEvents(
      ndk,
      targetWriteRelays,
      filter,
      initialUntil, // Pass determined starting 'until'
      stopAt, // Pass determined stopping 'until' (oldest)
      updateWriteProgress,
    );
    setIsWriteSyncing(false);

    if (success) {
      setWriteSyncProgress((prev) => ({
        ...prev,
        status: 'complete',
        message: 'Write sync finished!',
        syncedUntilTimestamp: undefined, // Clear resume point
        stopAtTimestamp: undefined, // Clear stop point display info
      }));
    }
  }, [
    decodedHex,
    outboxRelays,
    isWriteSyncing,
    isReadSyncing,
    writeSyncProgress,
    writeStartDate,
    writeEndDate,
  ]);

  // Handler for starting Read Relay Sync
  const handleReadSync = useCallback(async () => {
    if (!decodedHex || !outboxRelays || isWriteSyncing || isReadSyncing) return; // Prevent concurrent syncs

    const targetReadRelays = outboxRelays.filter(isReadRelay).map((r) => r.url);
    if (targetReadRelays.length === 0) {
      setReadSyncProgress({
        status: 'error',
        message: 'No read relays to sync.',
      });
      return;
    }

    setIsReadSyncing(true);

    // --- Determine initialUntil (Start Point) and stopAt (End Point) for Read ---
    let initialUntil: number;
    const stopAt = Math.floor(new Date(readEndDate).getTime() / 1000); // stopAt is always from readEndDate (Oldest)

    const canResume =
      readSyncProgress.syncedUntilTimestamp &&
      readSyncProgress.status !== 'error';

    if (canResume) {
      // RESUME
      initialUntil = readSyncProgress.syncedUntilTimestamp!;
      console.log(
        `Resuming read sync from timestamp: ${new Date(initialUntil * 1000).toLocaleString()}`,
      );
    } else {
      // START FRESH/RESTART
      initialUntil = Math.floor(new Date(readStartDate).getTime() / 1000);
      setReadSyncProgress((prev) => ({
        ...prev,
        syncedUntilTimestamp: undefined,
      }));
    }
    // --- End timestamp determination ---

    // Define filter for "inbox" events (events mentioning the user)
    const filter: NDKFilter = { '#p': [decodedHex], kinds: [1, 6, 7, 9735] };

    const updateReadProgress = (progress: SyncProgress) => {
      setReadSyncProgress((prev) => ({
        ...prev,
        ...progress,
        stopAtTimestamp: stopAt,
      }));
    };

    const success = await syncEvents(
      ndk,
      targetReadRelays,
      filter,
      initialUntil,
      stopAt,
      updateReadProgress,
    );

    setIsReadSyncing(false);

    // --- 최종 상태 업데이트 (Read용) ---
    if (success) {
      // 성공 시 재개 정보 초기화
      setReadSyncProgress((prev) => ({
        ...prev,
        status: 'complete',
        message: 'Read sync finished!',
        syncedUntilTimestamp: undefined, // 재개 지점 초기화
        stopAtTimestamp: undefined, // 종료 시점 초기화
      }));
    }
    // 실패 시에는 syncEvents 내부의 updateReadProgress 콜백이 에러 상태 및 syncedUntilTimestamp를 설정했을 것임
  }, [
    decodedHex,
    outboxRelays,
    isWriteSyncing,
    isReadSyncing,
    readSyncProgress,
    readStartDate,
    readEndDate,
  ]);

  const handleNip07Login = useCallback(async () => {
    if (!window.nostr) {
      await init({});
    }
    try {
      const signer = new NDKNip07Signer();
      ndk.signer = signer;
      const user = await signer.user();
      // console.log('NIP-07 User:', user);
      setInput(user.nprofile);
      setLoggedInUser(user);
      user.ndk = ndk;
    } catch (error) {
      console.error('NIP-07 Login failed:', error);
      alert(
        `Login failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      ndk.signer = undefined;
      setLoggedInUser(null);
    }
  }, []);

  const writeRelayList = outboxRelays?.filter(isWriteRelay) || [];
  const readRelayList = outboxRelays?.filter(isReadRelay) || [];

  // Render the UI
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

      <div
        style={{
          marginBottom: '1rem',
          paddingBottom: '1rem',
          borderBottom: '1px solid #eee',
        }}
      >
        {loggedInUser ? (
          <div>
            Logged in as:{' '}
            <strong>{nip19.npubEncode(loggedInUser.pubkey)}</strong>
            {/* 로그아웃 버튼 등 */}
          </div>
        ) : (
          // --- 로그인 버튼 및 설명문 ---
          <div>
            <button onClick={handleNip07Login} style={{ marginRight: '10px' }}>
              Login with Nostr (NIP-07 or NIP-46)
            </button>
            <p
              style={{
                fontSize: '0.85em',
                color: '#555',
                marginTop: '5px',
                marginBottom: '0',
              }}
            >
              Login is optional and not required for basic sync functionality.
              <br />
              It helps interact with relays that enforce stricter rate-limits or
              require authentication (NIP-42) for non-authenticated clients.
              <br />
              If you don't have a browser extension (NIP-07), this will attempt
              to use remote signing (NIP-46 via nostr-login).
            </p>
          </div>
          // --- 로그인 버튼 및 설명문 끝 ---
        )}
      </div>

      <p>
        Syncs past events to your designated write and read relays based on
        NIP-65.
      </p>

      {/* Input Section Component */}
      <InputSection
        input={input}
        setInput={setInput}
        handleDecode={handleDecode}
        isDecoding={isDecoding}
        isWriteSyncing={isWriteSyncing}
        isReadSyncing={isReadSyncing}
        decodeError={decodeError}
      />

      {/* Decoded Info Section Component */}
      <DecodedInfoSection
        decodedHex={decodedHex}
        profileRelays={profileRelays}
      />

      {/* Sync Panel Component */}
      {/* <SyncPanel
        outboxRelays={outboxRelays}
        decodedHex={decodedHex}
        writeSyncProgress={writeSyncProgress}
        isWriteSyncing={isWriteSyncing}
        handleWriteSync={handleWriteSync}
        readSyncProgress={readSyncProgress}
        isReadSyncing={isReadSyncing}
        handleReadSync={handleReadSync}
      /> */}
      {outboxRelays && decodedHex && (
        <div>
          <strong>📤 NIP-65 Relays Found:</strong>
          <div style={{ display: 'flex', marginTop: '1rem', gap: '1rem' }}>
            {/* Write Sync Section */}
            <SyncSection
              title="Write Relay Sync"
              targetRelayUrls={writeRelayList.map((r) => r.url)}
              // canStartSync 조건은 handleWriteSync에서 처리하므로 단순화 가능
              canStartSync={!!decodedHex && writeRelayList.length > 0}
              pubkey={decodedHex}
              syncProgress={writeSyncProgress}
              isSyncing={isWriteSyncing || isReadSyncing}
              onStartSync={handleWriteSync}
              isDisabledByLimit={writeRelayList.length > MAX_WRITE_RELAYS}
              // 날짜 상태 및 핸들러 전달
              startDate={writeStartDate}
              endDate={writeEndDate}
              onStartDateChange={setWriteStartDate}
              onEndDateChange={setWriteEndDate}
              updateSyncProgress={setWriteSyncProgress}
            />

            {/* Read Sync Section */}
            <SyncSection
              title="Read Relay Sync"
              targetRelayUrls={readRelayList.map((r) => r.url)}
              canStartSync={!!decodedHex && readRelayList.length > 0}
              pubkey={decodedHex}
              syncProgress={readSyncProgress}
              isSyncing={isWriteSyncing || isReadSyncing}
              onStartSync={handleReadSync}
              isDisabledByLimit={readRelayList.length > MAX_READ_RELAYS}
              // 날짜 상태 및 핸들러 전달
              startDate={readStartDate}
              endDate={readEndDate}
              onStartDateChange={setReadStartDate}
              onEndDateChange={setReadEndDate}
              updateSyncProgress={setReadSyncProgress}
            />
          </div>
        </div>
      )}

      {/* Message if NIP-65 could not be fetched */}
      {!outboxRelays && decodedHex && !isDecoding && !decodeError && (
        <div style={{ marginTop: '1rem', color: 'orange' }}>
          Could not find or fetch NIP-65 relay list (kind:10002). Sync is not
          possible.
        </div>
      )}
    </div>
  );
}

export default App;
