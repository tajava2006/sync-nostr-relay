import {
  SimplePool,
  Event,
  Filter,
  EventTemplate,
  VerifiedEvent,
} from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { normalizeURL } from 'nostr-tools/utils';
import React, { useState, useCallback } from 'react';
import SyncSection from './SyncSection';

interface RelayInfo {
  url: string;
  type: string;
}

// NIP-07 window.nostr 객체의 타입을 정의합니다.
// 필요한 메서드만 포함하거나 NIP-07 스펙 전체를 포함할 수 있습니다.
interface NostrProvider {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>; // nostr-tools의 Event는 보통 서명된 이벤트입니다.
  getRelays?(): Promise<{ [url: string]: { read: boolean; write: boolean } }>; // Optional
  nip04?: {
    // Optional
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

// 전역 Window 인터페이스에 nostr 속성을 추가합니다.
// '?'를 붙여 선택적(optional)으로 만듭니다. (확장 프로그램이 없을 수도 있으므로)
declare global {
  interface Window {
    nostr?: NostrProvider;
  }
}

// Default relays to use if user relay is not found or doesn't provide hints
const defaultRelays = [
  'wss://relay.damus.io/',
  'wss://hbr.coracle.social/',
  'wss://nos.lol/',
  'wss://purplepag.es/',
  'wss://relay.nostr.band/',
];

const NOSTR_TOOLS_DEFAULT_CLOSE_REASON = 'closed by caller';

// Helper function to check if a relay is marked for writing
const isWriteRelay = (relayInfo: RelayInfo): boolean => {
  return relayInfo.type.includes('Write');
};

// Helper function to check if a relay is marked for reading
const isReadRelay = (relayInfo: RelayInfo): boolean => {
  return relayInfo.type.includes('Read');
};

// Define possible statuses for the sync process
type SyncStatus =
  | 'idle'
  | 'fetching_relays'
  | 'fetching_batch'
  | 'syncing_event'
  | 'batch_complete'
  | 'error'
  | 'complete';

// Interface for the sync progress state object
export interface SyncProgress {
  status: SyncStatus;
  message: string;
  syncedUntilTimestamp?: number; // Timestamp until which events have been processed
  currentEventId?: string; // ID of the event currently being synced
  errorDetails?: string; // Specific reason for an error
}

// Fetches the user's NIP-65 relay list (kind:10002)
async function fetchOutboxRelays(
  pubkey: string,
  relays: string[] | null,
): Promise<RelayInfo[] | null> {
  const relaysToQuery = relays && relays.length > 0 ? relays : defaultRelays;
  const pool = new SimplePool();
  try {
    // Get the latest NIP-65 event
    const event = await pool.get(relaysToQuery, {
      kinds: [10002],
      authors: [pubkey],
      // limit: 1 // SimplePool's get already implies limit 1 based on latest
    });

    if (event && event.tags) {
      // Parse the 'r' tags into RelayInfo objects
      const relayInfo = event.tags
        .filter((tag: string[]) => tag[0] === 'r' && typeof tag[1] === 'string') // Ensure tag[1] is a string URL
        .map((tag: string[]) => ({
          url: normalizeURL(tag[1]),
          type: tag[2] // Check marker if present
            ? tag[2] === 'read'
              ? '📖 Read'
              : '✍️ Write'
            : '📖✍️ Read/Write', // Default to read/write if no marker
        }));
      return relayInfo.length > 0 ? relayInfo : null; // Return null if no valid 'r' tags found
    }
    return null; // No NIP-65 event found
  } catch (e) {
    console.error('Outbox relay fetch error:', e);
    return null;
  } finally {
    // Ensure pool resources are released
    pool.destroy();
  }
}

// Generalized sync function
async function syncEvents(
  targetRealyUrls: string[],
  filter: Filter,
  updateProgress: (progress: SyncProgress) => void,
): Promise<boolean> {
  if (targetRealyUrls.length === 0) {
    // Update progress and return if no relays are configured
    updateProgress({
      status: 'error',
      message: 'Error: No relays found in NIP-65 list.',
      // No timestamp to keep here as sync didn't start
    });
    return false;
  }

  // Create a pool for the sync process and enable tracking
  const syncPool = new SimplePool();
  syncPool.trackRelays = true; // Enable tracking which relays have which events

  // Initialize pagination timestamp and counters
  let syncUntilTimestamp = Math.floor(Date.now() / 1000);
  const batchSize = 20; // Number of events to fetch per batch
  // Apply initial batchSize limit to the passed filter
  filter.limit = batchSize;
  let allSynced = true; // Flag to track if the process completed without errors
  let totalSyncedCount = 0; // Counter for successfully synced/verified events

  updateProgress({
    status: 'fetching_batch', // Initial status before loop
    message: `Identified ${targetRealyUrls.length} target relays. Starting sync...`,
    syncedUntilTimestamp: syncUntilTimestamp, // Set initial timestamp
  });
  console.log(
    'Starting sync for filter:',
    filter,
    'on relays:',
    targetRealyUrls,
  );

  try {
    // Main loop for paginated fetching and syncing
    while (true) {
      // Update progress for the current batch fetch
      updateProgress({
        status: 'fetching_batch',
        message: `Fetching max ${batchSize} notes before ${new Date(syncUntilTimestamp * 1000).toLocaleString()}... (Total synced: ${totalSyncedCount})`,
        syncedUntilTimestamp: syncUntilTimestamp, // Pass current timestamp
      });

      // Update filter for pagination
      filter.until = syncUntilTimestamp;

      const eventsBeforeSliced: Event[] = [];
      try {
        const batchFetchTimeoutMs = 15_000; // Example: 15 seconds
        // console.log(`Querying relays ${targetRealyUrls.join(', ')}`);
        await new Promise((resolve, reject) => {
          let isHandled = false; // Flag to prevent duplicate handling

          const timeoutHandle = setTimeout(() => {
            if (isHandled) return;
            isHandled = true;
            allSynced = false;
            console.error(
              `>>> Batch fetch timeout (${batchFetchTimeoutMs - 3_000}ms) exceeded.`,
            );
            try {
              sub?.close();
            } catch (e) {
              console.warn(e);
            }
            reject(
              new Error(
                `Batch fetch timed out after ${batchFetchTimeoutMs - 3_000}ms`,
              ),
            );
          }, batchFetchTimeoutMs - 3_000);

          const sub = syncPool.subscribe(targetRealyUrls, filter, {
            maxWait: batchFetchTimeoutMs,
            onevent(event: Event) {
              eventsBeforeSliced.push(event);
            },
            oneose: () => {
              if (isHandled) return;
              isHandled = true;
              clearTimeout(timeoutHandle);
              console.log(
                `EOSE received. Total events fetched: ${eventsBeforeSliced.length}`,
              );
              sub.close(); // EOSE 후 구독 종료
            },
            onclose: (reasons) => {
              // Note: This will be called AFTER oneose because of nostr-tools SimplePool behavior
              isHandled = true; // Mark as handled to prevent potential race with oneose/timeout
              clearTimeout(timeoutHandle);
              const expectedReason = NOSTR_TOOLS_DEFAULT_CLOSE_REASON;
              console.log('Closed handler, reasons: ', reasons);
              const unexpectedReasons = reasons.filter(
                (reason) => reason !== expectedReason,
              );
              if (unexpectedReasons.length > 0) {
                console.error(
                  '>>> Unexpected closure detected:',
                  unexpectedReasons,
                );
                allSynced = false; // Set flag to break outer loop
                reject(
                  new Error(
                    `Unexpected closure: ${unexpectedReasons.join(', ')}`,
                  ),
                ); // Reject on unexpected close
              } else {
                resolve(eventsBeforeSliced);
              }
            },
          });
        }); // End of new Promise
        console.log(
          `Fetched ${eventsBeforeSliced.length} events for batch before ${syncUntilTimestamp}`,
        );
      } catch (queryError: any) {
        console.error('Error fetching event batch with querySync:', queryError);
        // Update progress on fetch error, preserving the last known timestamp
        updateProgress({
          status: 'error',
          message: `Error fetching event batch.`,
          syncedUntilTimestamp: syncUntilTimestamp, // Keep the timestamp
          errorDetails: queryError.message || String(queryError), // Add error details
        });
        allSynced = false;
        break; // Exit the loop on fetch error
      }

      // Check if no more events were found in the specified time range
      if (eventsBeforeSliced.length === 0) {
        updateProgress({
          status: 'complete',
          message: `Sync complete! No more older events found. Total synced: ${totalSyncedCount}`,
          syncedUntilTimestamp: syncUntilTimestamp, // Keep the final timestamp
        });
        console.log('Sync complete');
        break; // Exit the loop, sync finished
      }

      // Sort events newest first to prepare for slicing
      eventsBeforeSliced.sort((a, b) => b.created_at - a.created_at);

      // Slice the fetched events to the target batch size. This prevents skipping events if one relay
      // provides much older events than another within the querySync limit, ensuring the next 'until'
      // timestamp is based on processed data
      const events = eventsBeforeSliced.slice(0, batchSize);

      // Calculate the timestamp for the next iteration based on the *sliced* batch
      const batchOldestTimestamp = events[events.length - 1].created_at;

      // console.log(events, 111);
      // return false;

      // Process each event in the fetched batch
      for (const event of events) {
        // Update progress for the specific event being processed
        updateProgress({
          status: 'syncing_event',
          message: `Syncing event ${event.id.substring(0, 8)}... (created: ${new Date(event.created_at * 1000).toLocaleString()})`,
          currentEventId: event.id,
          syncedUntilTimestamp: syncUntilTimestamp, // Keep timestamp during sync
        });
        console.log(
          `Attempting to sync event ${event.id} to ${targetRealyUrls.length} target relays.`,
        );

        // Get the set of relays known to have seen this event
        const relaysThatHaveEventSet = syncPool.seenOn.get(event.id);

        // Convert the set to a list of URLs, handling cases where the set might be missing
        const urlsThatHaveEvent = relaysThatHaveEventSet
          ? Array.from(relaysThatHaveEventSet).map((r) => r.url)
          : [];

        // Determine which relays *don't* have this event according to seenOn
        const relaysToPublishTo = targetRealyUrls.filter(
          (url) => !urlsThatHaveEvent.includes(url),
        );

        // If all target relays already have the event, skip publishing
        if (relaysToPublishTo.length === 0) {
          console.log(
            `Event ${event.id.substring(0, 8)} already exists on all target relays according to seenOn.`,
          );
          totalSyncedCount++; // Count as synced/verified
          continue; // Move to the next event in the batch
        }

        console.log(
          `Publishing event ${event.id.substring(0, 8)} to ${relaysToPublishTo.length} relays: ${relaysToPublishTo.join(', ')}`,
        );

        try {
          // Publish the event only to the relays that don't have it
          const publishPromises = syncPool.publish(relaysToPublishTo, event);

          // Wait for all publish attempts to settle (succeed or fail)
          const results = await Promise.allSettled(publishPromises);

          const failedRelays: string[] = [];
          // Check the results for each publish attempt
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              // If a publish failed, record the relay URL and reason
              const failedUrl = relaysToPublishTo[index];
              failedRelays.push(failedUrl);
              console.error(
                `Failed to publish event ${event.id.substring(0, 8)} to relay ${failedUrl}:`,
                result.reason, // Log the specific reason (e.g., 'timed out', 'blocked: rate-limited')
              );
            } else {
              // Log success for clarity
              const successUrl = relaysToPublishTo[index];
              console.log(
                `Publish confirmed/sent for event ${event.id.substring(0, 8)} to relay ${successUrl}: ${result.value}`,
              );
            }
          });

          // If any publishes failed, stop the entire sync process
          if (failedRelays.length > 0) {
            // Extract specific reasons if possible, otherwise join URLs
            const failureReasons = results
              .filter((res) => res.status === 'rejected')
              .map((res: PromiseRejectedResult) => String(res.reason)) // Convert reasons to strings
              .join('; '); // Join reasons with semicolon

            const errorMsg = `Error: Failed to publish event ${event.id.substring(0, 8)} to ${failedRelays.length} relays. Stopping sync.`;
            updateProgress({
              status: 'error',
              message: errorMsg,
              currentEventId: event.id,
              syncedUntilTimestamp: syncUntilTimestamp, // Keep the timestamp on error
              errorDetails: `Failed relays: ${failedRelays.join(', ')}. Reasons: ${failureReasons}`, // Provide detailed error info
            });
            console.error(errorMsg);
            allSynced = false;
            break; // Exit the inner for loop
          } else {
            // If all publishes succeeded for this event
            totalSyncedCount++; // Increment the synced count
          }
        } catch (publishError: any) {
          // Catch unexpected errors during the publish phase
          const errorMsg = `Unexpected error publishing event ${event.id}: ${publishError.message || publishError}. Stopping sync.`;
          updateProgress({
            status: 'error',
            message: errorMsg,
            currentEventId: event.id,
            syncedUntilTimestamp: syncUntilTimestamp, // Keep the timestamp on error
            errorDetails: String(publishError), // Provide error details
          });
          console.error(errorMsg, publishError);
          allSynced = false;
          break; // Exit the inner for loop
        }

        // Optional delay between publishing individual events within a batch to reduce load
        await new Promise((resolve) => setTimeout(resolve, 5_000)); // e.g., 5s delay
      } // End of for (const event of events) loop

      // If an error occurred within the inner loop, exit the outer while loop too
      if (!allSynced) {
        break;
      }

      // Update the timestamp for the next batch fetch
      // Use the timestamp of the oldest event processed in this batch
      syncUntilTimestamp = batchOldestTimestamp;

      // Update progress after completing a batch successfully
      updateProgress({
        status: 'batch_complete',
        message: `Batch synced. Continuing before ${new Date(syncUntilTimestamp * 1000).toLocaleString()} (Total synced: ${totalSyncedCount})`,
        syncedUntilTimestamp: syncUntilTimestamp,
      });

      // Optional delay between batches to avoid overwhelming relays
      await new Promise((resolve) => setTimeout(resolve, 10_000)); // e.g., 10s delay

      // If the number of events fetched was less than the batch size, we've likely reached the end
      if (events.length < batchSize) {
        updateProgress({
          status: 'complete',
          message: `Sync complete! Reached end of history. Total synced: ${totalSyncedCount}`,
          syncedUntilTimestamp: syncUntilTimestamp, // Keep the final timestamp
        });
        console.log('Sync complete - likely reached end of history.');
        break; // Exit the loop, sync finished
      }
    } // End of while(true) loop
  } catch (error: any) {
    // Catch any other unhandled errors in the sync process
    updateProgress({
      status: 'error',
      message: `Unhandled sync error.`,
      syncedUntilTimestamp: syncUntilTimestamp, // Try to keep timestamp if available
      errorDetails: error.message || String(error), // Provide error details
    });
    console.error('Unhandled sync error:', error);
    allSynced = false;
  } finally {
    // Clean up the pool resources regardless of success or failure
    syncPool.destroy(); // if available and appropriate
  }

  // Return whether the sync completed without errors
  return allSynced;
}

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

  // Filter relays for display
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
      <p>
        Syncs past events to your designated write and read relays based on
        NIP-65.
      </p>

      {/* Input Section */}
      <div style={{ marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="npub1... or nprofile1..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isDecoding || isWriteSyncing || isReadSyncing}
          style={{
            width: 'calc(100% - 110px)',
            padding: '0.5rem',
            fontSize: '1rem',
            marginRight: '10px',
          }}
        />
        <button
          onClick={handleDecode}
          disabled={isDecoding || isWriteSyncing || isReadSyncing}
          style={{ padding: '0.5rem 1rem' }}
        >
          {isDecoding ? 'Decoding...' : 'Decode'}
        </button>
        {decodeError && (
          <div style={{ marginTop: '0.5rem', color: 'red' }}>
            Error: {decodeError}
          </div>
        )}
      </div>

      {/* Decoded Info Section */}
      {decodedHex && (
        <div style={{ marginBottom: '1rem' }}>
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
          {profileRelays && profileRelays.length > 0 && (
            <div>
              <strong>ℹ️ Relays from nprofile:</strong>
              <ul
                style={{
                  background: '#f8f8f8',
                  padding: '0.5rem 1rem',
                  listStyle: 'none',
                  margin: '0.5rem 0',
                  maxHeight: '60px',
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
        </div>
      )}

      {/* NIP-65 and Sync Sections */}
      {outboxRelays && decodedHex && (
        <div>
          <strong>📤 NIP-65 Relays Found:</strong>
          {/* Maybe display the full list briefly here if desired */}

          {/* Two Column Layout for Sync Sections */}
          <div style={{ display: 'flex', marginTop: '1rem', gap: '1rem' }}>
            {/* Write Sync Section */}
            <SyncSection
              title="Write Relay Sync"
              targetRelayUrls={writeRelayList.map((r) => r.url)}
              filterToSync={
                writeRelayList.length > 0
                  ? { kinds: [1], authors: [decodedHex] }
                  : null
              }
              pubkey={decodedHex}
              syncProgress={writeSyncProgress}
              isSyncing={isWriteSyncing || isReadSyncing} // Disable button if *either* is syncing
              onStartSync={handleWriteSync}
            />

            {/* Read Sync Section */}
            <SyncSection
              title="Read Relay Sync"
              targetRelayUrls={readRelayList.map((r) => r.url)}
              filterToSync={
                readRelayList.length > 0
                  ? { '#p': [decodedHex], kinds: [1, 6, 7, 9735] }
                  : null
              } // Example filter
              pubkey={decodedHex}
              syncProgress={readSyncProgress}
              isSyncing={isWriteSyncing || isReadSyncing} // Disable button if *either* is syncing
              onStartSync={handleReadSync}
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
