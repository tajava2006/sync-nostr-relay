import { Event, Filter, SimplePool } from "nostr-tools";
import { RelayInfo, SyncProgress } from "./types";
import { normalizeURL } from "nostr-tools/utils";
import { NOSTR_TOOLS_DEFAULT_CLOSE_REASON } from './constant';
import NDK, {
  NDKEvent,
  NDKFilter,
  NDKKind,
  NDKRelaySet,
} from '@nostr-dev-kit/ndk';

// Helper function to check if a relay is marked for writing
export const isWriteRelay = (relayInfo: RelayInfo): boolean => {
  return relayInfo.type.includes('Write');
};

// Helper function to check if a relay is marked for reading
export const isReadRelay = (relayInfo: RelayInfo): boolean => {
  return relayInfo.type.includes('Read');
};

// Fetches the user's NIP-65 relay list (kind:10002)
export async function fetchOutboxRelays(
  ndk: NDK,
  pubkey: string,
  profileRelayHints: string[] | null,
): Promise<RelayInfo[] | null> {
  try {
    const filter: NDKFilter = {
      kinds: [NDKKind.RelayList],
      authors: [pubkey],
    };

    let event: NDKEvent | null = null;
    if (profileRelayHints) {
      const relaySet = NDKRelaySet.fromRelayUrls(profileRelayHints, ndk);
      event = await ndk.fetchEvent(filter, {}, relaySet);
    } else {
      event = await ndk.fetchEvent(filter);
    }

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
    console.log(
      `NIP-65 (Kind ${NDKKind.RelayList}) event not found for pubkey: ${pubkey}`,
    );
    return null;
  } catch (e) {
    console.error('NDK Outbox relay fetch error:', e);
    return null;
  }
}


// Generalized sync function
export async function syncEvents(
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
              sub.close();
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

      // console.log(eventsBeforeSliced, batchOldestTimestamp, syncUntilTimestamp, totalSyncedCount, 111);
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
