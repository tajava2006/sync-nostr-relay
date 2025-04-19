import { Filter } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import React, { useState, useCallback, useEffect } from 'react';
import { RelayInfo, SyncProgress } from './components/types';
import { SyncPanel } from './components/SyncPanel';
import {
  fetchOutboxRelays,
  isReadRelay,
  isWriteRelay,
  syncEvents,
} from './components/util';
import { InputSection } from './components/InputSection';
import { DecodedInfoSection } from './components/DecodedInfoSection';
import NDK, { NDKNip07Signer, NDKUser, NDKRelay } from '@nostr-dev-kit/ndk';
import { DEFAULT_RELAYS } from './components/constant';

// Create NDK instance (outside component)
const ndk = new NDK({
  explicitRelayUrls: DEFAULT_RELAYS,
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
      const relayInfo = await fetchOutboxRelays(pubkeyHex, relaysFromProfile);
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
    } catch (e: any) {
      setDecodeError(
        `Decoding failed: ${e.message || 'Invalid NIP-19 string?'}`,
      );
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
    const filter: Filter = { kinds: [1, 6, 30023], authors: [decodedHex] };
    const success = await syncEvents(
      targetWriteRelays,
      filter,
      setWriteSyncProgress,
    );
    setIsWriteSyncing(false);

    if (success && writeSyncProgress.status !== 'complete') {
      setWriteSyncProgress((prev) => ({
        ...prev,
        status: 'complete',
        message: 'Write sync finished!',
      }));
    } else if (!success && writeSyncProgress.status !== 'error') {
      setWriteSyncProgress((prev) => ({
        ...prev,
        status: 'error',
        message: 'Write sync stopped.',
        errorDetails: prev.errorDetails || 'Unknown reason.',
      }));
    }
  }, [
    decodedHex,
    outboxRelays,
    isWriteSyncing,
    isReadSyncing,
    writeSyncProgress.status,
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
    // Define filter for "inbox" events (events mentioning the user)
    const filter: Filter = { '#p': [decodedHex], kinds: [1, 6, 7, 9735] };
    const success = await syncEvents(
      targetReadRelays,
      filter,
      setReadSyncProgress,
    );
    setIsReadSyncing(false);

    if (success && readSyncProgress.status !== 'complete') {
      setReadSyncProgress((prev) => ({
        ...prev,
        status: 'complete',
        message: 'Read sync finished!',
      }));
    } else if (!success && readSyncProgress.status !== 'error') {
      setReadSyncProgress((prev) => ({
        ...prev,
        status: 'error',
        message: 'Read sync stopped.',
        errorDetails: prev.errorDetails || 'Unknown reason.',
      }));
    }
  }, [
    decodedHex,
    outboxRelays,
    isWriteSyncing,
    isReadSyncing,
    readSyncProgress.status,
  ]);

  const handleNip07Login = useCallback(async () => {
    if (!window.nostr) {
      console.error('NIP-07 Extension not found on login attempt.');
      alert(
        'NIP-07 compatible extension (like Alby, nos2x) not found. Please install one and refresh the page.',
      );
      return;
    }
    try {
      const signer = new NDKNip07Signer();
      ndk.signer = signer;
      const user = await signer.user();
      console.log('NIP-07 User:', user);
      setInput(user.nprofile);
      setLoggedInUser(user);
      user.ndk = ndk;
      await user.fetchProfile();
    } catch (error) {
      console.error('NIP-07 Login failed:', error);
      alert(
        `Login failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      ndk.signer = undefined;
      setLoggedInUser(null);
    }
  }, []);

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
          // --- 항상 로그인 버튼 표시 ---
          <button onClick={handleNip07Login}>
            Login with Extension (NIP-07)
          </button>
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
      <SyncPanel
        outboxRelays={outboxRelays}
        decodedHex={decodedHex}
        writeSyncProgress={writeSyncProgress}
        isWriteSyncing={isWriteSyncing}
        handleWriteSync={handleWriteSync}
        readSyncProgress={readSyncProgress}
        isReadSyncing={isReadSyncing}
        handleReadSync={handleReadSync}
      />

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
