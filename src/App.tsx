import { Filter } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import React, { useState, useCallback } from 'react';
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
    const filter: Filter = { kinds: [1], authors: [decodedHex] };
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
    const filter: Filter = { '#p': [decodedHex], kinds: [1, 6, 7, 9735] }; // Example filter
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

      {/* Sync Panel 렌더링 */}
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
