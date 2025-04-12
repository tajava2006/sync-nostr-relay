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
interface SyncProgress {
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

async function syncInboxRelaysOfEnent(
  eventId: string,
  inboxRelayUrls: string[],
  syncPool: SimplePool,
) {
  console.log(
    'Syncing inbox relays of event',
    eventId,
    'on relays:',
    inboxRelayUrls,
    'with syncPool:',
    syncPool,
  );
}

// Main function to synchronize past events (kind:1 notes)
async function syncEvents(
  pubkey: string,
  allRelaysInfo: RelayInfo[],
  updateProgress: (progress: SyncProgress) => void,
): Promise<boolean> {
  // Identify target relays marked for writing
  const writeRelayUrls = allRelaysInfo.filter(isWriteRelay).map((r) => r.url);
  const readRelayUrls = allRelaysInfo.filter(isReadRelay).map((r) => r.url);

  if (writeRelayUrls.length === 0) {
    // Update progress and return if no write relays are configured
    updateProgress({
      status: 'error',
      message: 'Error: No write relays found in NIP-65 list.',
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
  let allSynced = true; // Flag to track if the process completed without errors
  let totalSyncedCount = 0; // Counter for successfully synced/verified events

  updateProgress({
    status: 'fetching_batch', // Initial status before loop
    message: `Identified ${writeRelayUrls.length} write relays. Starting sync...`,
    syncedUntilTimestamp: syncUntilTimestamp, // Set initial timestamp
  });
  console.log('Starting sync for', pubkey, 'on write relays:', writeRelayUrls);

  try {
    // Main loop for paginated fetching and syncing
    while (true) {
      // Update progress for the current batch fetch
      updateProgress({
        status: 'fetching_batch',
        message: `Fetching max ${batchSize} notes before ${new Date(syncUntilTimestamp * 1000).toLocaleString()}... (Total synced: ${totalSyncedCount})`,
        syncedUntilTimestamp: syncUntilTimestamp, // Pass current timestamp
      });

      // Define the filter for fetching the next batch of events
      const filter: Filter = {
        kinds: [1], // Only sync notes
        authors: [pubkey],
        until: syncUntilTimestamp, // Fetch events older than this timestamp
        limit: batchSize,
      };

      const eventsBeforeSliced: Event[] = [];
      try {
        const batchFetchTimeoutMs = 15_000; // Example: 15 seconds
        // console.log(`Querying relays ${writeRelayUrls.join(', ')}`);
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

          const sub = syncPool.subscribe(writeRelayUrls, filter, {
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
                reject(`Close before Eose: ${unexpectedReasons.join()}`);
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
        console.log('Sync complete for', pubkey);
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
          `Attempting to sync event ${event.id} to ${writeRelayUrls.length} target relays.`,
        );

        // Get the set of relays known to have seen this event
        const relaysThatHaveEventSet = syncPool.seenOn.get(event.id);

        // Convert the set to a list of URLs, handling cases where the set might be missing
        const urlsThatHaveEvent = relaysThatHaveEventSet
          ? Array.from(relaysThatHaveEventSet).map((r) => r.url)
          : [];

        // Determine which write relays *don't* have this event according to seenOn
        const relaysToPublishTo = writeRelayUrls.filter(
          (url) => !urlsThatHaveEvent.includes(url),
        );

        // If all target relays already have the event, skip publishing
        if (relaysToPublishTo.length === 0) {
          console.log(
            `Event ${event.id.substring(0, 8)} already exists on all target write relays according to seenOn.`,
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

        // Sync all inbox relays of the event
        await syncInboxRelaysOfEnent(event.id, readRelayUrls, syncPool);

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
        console.log(
          'Sync complete for',
          pubkey,
          '- likely reached end of history.',
        );
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
  // State to track if syncing is in progress
  const [isSyncing, setIsSyncing] = useState(false);
  // State for displaying sync progress and status
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    status: 'idle',
    message: 'Enter npub or nprofile and click Decode.',
  });

  // Handler for the Decode button click
  const handleDecode = useCallback(async () => {
    setIsDecoding(true);
    setDecodeError(null);
    setDecodedHex(null);
    setProfileRelays(null);
    setOutboxRelays(null);
    setSyncProgress({ status: 'idle', message: 'Decoding...' }); // Reset progress

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
      setSyncProgress({
        status: 'fetching_relays',
        message: 'Fetching NIP-65 relay list...',
      });

      // Fetch the NIP-65 relay list
      const relayInfo = await fetchOutboxRelays(pubkeyHex, relaysFromProfile);
      if (relayInfo) {
        setOutboxRelays(relayInfo);
        const writeRelaysCount = relayInfo.filter(isWriteRelay).length;
        setSyncProgress({
          status: 'idle',
          message: `Found ${relayInfo.length} relays in NIP-65 (${writeRelaysCount} write). Ready to sync.`,
        });
      } else {
        // Handle case where NIP-65 is not found
        setSyncProgress({
          status: 'idle',
          message: 'Could not find NIP-65 relay list. Sync disabled.',
        });
        setDecodeError(
          'Could not find or fetch NIP-65 relay list (kind:10002).',
        );
      }
    } catch (e: any) {
      // Handle decoding or fetch errors
      setDecodeError(
        `Decoding failed: ${e.message || 'Invalid NIP-19 string?'}`,
      );
      console.error('Decode error:', e);
      setSyncProgress({ status: 'idle', message: 'Decode failed.' });
    } finally {
      setIsDecoding(false);
    }
  }, [input]); // Dependency: input state

  // Handler for the Sync button click
  const handleSync = useCallback(async () => {
    // Prevent sync if already running or necessary data is missing
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
    // Pass setSyncProgress as the callback to update UI
    const success = await syncEvents(decodedHex, outboxRelays, setSyncProgress);
    setIsSyncing(false);

    // Update final status message if needed (syncEvents should set final status)
    if (success && syncProgress.status !== 'complete') {
      setSyncProgress((prev) => ({
        ...prev,
        status: 'complete',
        message: prev.message.startsWith('Sync complete!')
          ? prev.message
          : 'Sync finished successfully!', // Avoid overwriting specific complete message
      }));
    } else if (!success && syncProgress.status !== 'error') {
      // Handle unexpected non-error failure
      setSyncProgress((prev) => ({
        ...prev,
        status: 'error',
        message: prev.message || 'Sync stopped or failed unexpectedly.',
        errorDetails: prev.errorDetails || 'Unknown reason.',
      }));
    }
  }, [decodedHex, outboxRelays, isSyncing, syncProgress.status]); // Dependencies for the callback

  // Filter relays for display purposes
  const doubleRelay =
    outboxRelays?.filter((relay) => {
      return isReadRelay(relay) && isWriteRelay(relay);
    }) || [];
  const writeRelays = outboxRelays?.filter(isWriteRelay) || []; // Used for enabling sync button
  const writeOnlyRelays =
    outboxRelays?.filter((relay) => {
      return isWriteRelay(relay) && !isReadRelay(relay);
    }) || [];
  const readOnlyRelays =
    outboxRelays?.filter((relay) => {
      return isReadRelay(relay) && !isWriteRelay(relay);
    }) || [];

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
        Syncs your past notes (kind:1) across all 'write' relays listed in your
        NIP-65 (kind:10002).
      </p>
      {/* Input and Decode Button */}
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

      {/* Display Decoding Error */}
      {decodeError && (
        <div style={{ marginTop: '1rem', color: 'red' }}>
          Error: {decodeError}
        </div>
      )}

      {/* Display Decoded Pubkey */}
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

      {/* Display Relays from nprofile (if any) */}
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

      {/* Display Parsed NIP-65 Relays */}
      {outboxRelays && (
        <div style={{ marginTop: '1rem' }}>
          <strong>📤 NIP-65 Relays:</strong>
          {/* Display Read/Write Relays */}
          {doubleRelay.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <strong>📖✍️ Read/Write ({doubleRelay.length}):</strong>
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
                  <li key={`rw-${idx}`} style={{ wordBreak: 'break-all' }}>
                    {relay.url}{' '}
                    <span style={{ color: '#666' }}>({relay.type})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Display Write-Only Relays */}
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
          {/* Display Read-Only Relays */}
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
          {/* Sync Control Section (only if write relays exist) */}
          {writeRelays.length > 0 ? (
            <div
              style={{
                marginTop: '1.5rem',
                border: '1px solid #ccc',
                padding: '1rem',
              }}
            >
              <h3>Sync Status</h3>
              {/* Sync Button */}
              <button
                onClick={handleSync}
                disabled={
                  isSyncing ||
                  writeRelays.length === 0 ||
                  syncProgress.status === 'fetching_relays' || // Disable while fetching NIP-65
                  syncProgress.status === 'fetching_batch' || // Disable during sync phases
                  syncProgress.status === 'syncing_event'
                }
                style={{ padding: '0.5rem 1rem', marginBottom: '1rem' }}
              >
                {isSyncing ? 'Syncing...' : 'Start Full Sync (kind:1)'}
              </button>
              {/* Sync Progress Display Area */}
              <div style={{ minHeight: '4em' }}>
                <div>
                  <strong>Status:</strong> {syncProgress.message}
                </div>
                {/* Display timestamp when available */}
                {syncProgress.syncedUntilTimestamp && (
                  <div style={{ fontSize: '0.9em', color: '#555' }}>
                    Processed events before:{' '}
                    {new Date(
                      syncProgress.syncedUntilTimestamp * 1000,
                    ).toLocaleString()}
                  </div>
                )}
                {/* Display current event ID during sync */}
                {isSyncing && syncProgress.currentEventId && (
                  <div style={{ fontSize: '0.9em', color: '#555' }}>
                    Current Event:{' '}
                    {syncProgress.currentEventId.substring(0, 10)}...
                  </div>
                )}
                {/* Display error details if status is error */}
                {syncProgress.status === 'error' &&
                  syncProgress.errorDetails && (
                    <div
                      style={{
                        fontSize: '0.9em',
                        color: 'red',
                        marginTop: '0.5em',
                      }}
                    >
                      <strong>Details:</strong> {syncProgress.errorDetails}
                    </div>
                  )}
                {/* Display success message on completion */}
                {syncProgress.status === 'complete' && (
                  <div
                    style={{
                      color: 'green',
                      fontWeight: 'bold',
                      marginTop: '0.5em',
                    }}
                  >
                    Synchronization finished!
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Warning if no write relays are found
            <div style={{ marginTop: '1rem', color: 'orange' }}>
              Warning: No 'write' relays found in NIP-65 list. Sync cannot
              proceed.
            </div>
          )}
        </div>
      )}
      {/* Message if NIP-65 could not be fetched */}
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
