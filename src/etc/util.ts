import { RelayInfo, SyncProgress } from './types';
import { normalizeURL } from 'nostr-tools/utils';
import NDK, {
  NDKEvent,
  NDKFilter,
  NDKKind,
  NDKPublishError,
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

export const formatDateForInput = (date: Date): string => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
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
  ndk: NDK,
  targetRealyUrls: string[],
  filter: NDKFilter,
  initialUntilTimestamp: number, // 시작할 Until 타임스탬프
  syncStopAtTimestamp: number | undefined, // 멈출 타임스탬프
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
  const relaySet = NDKRelaySet.fromRelayUrls(targetRealyUrls, ndk);

  // Initialize pagination timestamp and counters
  let syncUntilTimestamp = initialUntilTimestamp;
  const batchSize = 20; // Number of events to fetch per batch
  // Apply initial batchSize limit to the passed filter
  filter.limit = batchSize;
  let allSynced = true; // Flag to track if the process completed without errors
  let totalSyncedCount = 0; // Counter for successfully synced/verified events

  updateProgress({
    status: 'fetching_batch', // Initial status before loop
    message: `Identified ${targetRealyUrls.length} target relays. Starting sync...`,
    syncedUntilTimestamp: syncUntilTimestamp,
    stopAtTimestamp: syncStopAtTimestamp,
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
        syncedUntilTimestamp: syncUntilTimestamp,
        stopAtTimestamp: syncStopAtTimestamp,
      });

      // Update filter for pagination
      filter.until = syncUntilTimestamp;

      const eventsBeforeSliced: NDKEvent[] = [];
      try {
        await new Promise((resolve) => {
          ndk.subscribe(
            filter,
            {
              groupable: true,
              groupableDelay: 1000,
              closeOnEose: true,
              relaySet: relaySet,
            },
            {
              onEvent: (event: NDKEvent) => {
                eventsBeforeSliced.push(event);
              },
              onEose: () => {
                resolve(eventsBeforeSliced);
              },
            },
          );
        });
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
          stopAtTimestamp: syncStopAtTimestamp,
          errorDetails: queryError.message || String(queryError), // Add error details
        });
        return false;
      }

      // Check if no more events were found in the specified time range
      if (eventsBeforeSliced.length === 0) {
        updateProgress({
          status: 'complete',
          message: `Sync complete! No more older events found${syncStopAtTimestamp ? ' within range' : ''}. Total synced: ${totalSyncedCount}`,
          syncedUntilTimestamp: syncUntilTimestamp, // Final 'until' value
          stopAtTimestamp: syncStopAtTimestamp,
        });
        return true;
      }

      // Sort events newest first to prepare for slicing
      eventsBeforeSliced.sort((a, b) => b.created_at - a.created_at);

      // Slice the fetched events to the target batch size. This prevents skipping events if one relay
      // provides much older events than another within the querySync limit, ensuring the next 'until'
      // timestamp is based on processed data
      const events = eventsBeforeSliced.slice(0, batchSize);

      // Calculate the timestamp for the next iteration based on the *sliced* batch
      const batchOldestTimestamp = events[events.length - 1].created_at;

      for (const [, relay] of ndk.pool.relays) {
        if (!relaySet.relays.has(relay)) continue;
        if (relay.connected) continue;
        console.warn('disconnected relay: ', relay);
        updateProgress({
          status: 'error',
          message: 'stop',
          errorDetails: `Unable to connect ${relay.url}`,
          syncedUntilTimestamp: syncUntilTimestamp,
        });
        return false;
      }

      // Process each event in the fetched batch
      for (const event of events) {
        // --- check within the loop for stopAt ---
        // If user specified a stop time, and this event is older than that, stop processing this batch.
        // This prevents syncing events slightly older than the requested 'end date' if they came in the same batch.
        if (syncStopAtTimestamp && event.created_at < syncStopAtTimestamp) {
          console.log(
            `Event ${event.id.substring(0, 8)} (${event.created_at}) is older than stopAt timestamp (${syncStopAtTimestamp}). Stopping processing this batch.`,
          );
          // Mark that we potentially stopped mid-batch due to stopAt
          // We'll handle completion outside the loop based on reachedStopAt flag
          break; // Exit the 'for' loop for this batch
        }
        // --- End stopAt check ---
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

        // Get the list of relays known to have seen this event
        const relayListThatHaveEvent = ndk.subManager.seenEvents.get(event.id);

        // Convert the set to a list of URLs, handling cases where the set might be missing
        const urlsThatHaveEvent = relayListThatHaveEvent
          ? relayListThatHaveEvent.map((r) => r.url)
          : [];

        // Determine which relays *don't* have this event according to seenOn
        const relaysToPublishTo = targetRealyUrls.filter(
          (url) => !urlsThatHaveEvent.includes(url),
        );
        const ndkRelayToPublish = NDKRelaySet.fromRelayUrls(
          relaysToPublishTo,
          ndk,
        );

        // If all target relays already have the event, skip publishing
        if (ndkRelayToPublish.size === 0) {
          console.log(
            `Event ${event.id.substring(0, 8)} already exists on all target relays according to seenOn.`,
          );
          totalSyncedCount++; // Count as synced/verified
          continue; // Move to the next event in the batch
        }

        console.log(
          `Publishing event ${event.id.substring(0, 8)} to ${ndkRelayToPublish.size} relays: ${relaysToPublishTo.join(', ')}`,
        );

        try {
          await event.publish(ndkRelayToPublish, 5_000, ndkRelayToPublish.size);
          totalSyncedCount++;
        } catch (publishError: any) {
          let failedRelaysInfo = 'Unknown failure reason';

          if (publishError instanceof NDKPublishError) {
            const reasons = Array.from(publishError.errors.entries())
              .map(([relay, error]) => `${relay.url}: ${error.message}`)
              .join('; ');
            failedRelaysInfo = `Failed relays (${publishError.errors.size}): ${reasons}`;
            console.warn(
              'Publish failed. Errors per relay:',
              publishError.errors.entries(),
            );
          } else if (publishError instanceof Error) {
            failedRelaysInfo = publishError.message;
          } else {
            failedRelaysInfo = String(publishError);
          }

          if (failedRelaysInfo.includes('deletion')) {
            console.log(`user requested deletion: ${event.id}`);
          } else {
            const errorMsg = `Error publishing event ${event.id}. Stopping sync.`;
            updateProgress({
              status: 'error',
              message: errorMsg,
              currentEventId: event.id,
              syncedUntilTimestamp: syncUntilTimestamp,
              errorDetails: failedRelaysInfo,
            });
            return false;
          }
        }

        // Optional delay between publishing individual events within a batch to reduce load
        await new Promise((resolve) => setTimeout(resolve, 10_000)); // e.g., 10s delay
      } // End of for (const event of events) loop
      // Update timestamp for the next iteration *after* processing the loop
      syncUntilTimestamp = batchOldestTimestamp - 1;

      const reachedStopAt =
        syncStopAtTimestamp && batchOldestTimestamp <= syncStopAtTimestamp;
      if (reachedStopAt) {
        // If the oldest processed event hit or passed the stop timestamp, consider it complete for the range
        updateProgress({
          status: 'complete',
          message: `Sync complete! Reached the specified oldest date. Total synced: ${totalSyncedCount}`,
          syncedUntilTimestamp: syncUntilTimestamp,
          stopAtTimestamp: syncStopAtTimestamp,
        });
        return true;
      }

      // Update progress after completing a batch successfully
      updateProgress({
        status: 'batch_complete',
        message: `Batch synced. Continuing before ${new Date(syncUntilTimestamp * 1000).toLocaleString()} (Total synced: ${totalSyncedCount})`,
        syncedUntilTimestamp: syncUntilTimestamp,
      });

      // Optional delay between batches to avoid overwhelming relays
      await new Promise((resolve) => setTimeout(resolve, 10_000)); // e.g., 10s delay
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
  }

  // Return whether the sync completed without errors
  return allSynced;
}
