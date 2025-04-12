# Nostr NIP-65 Relay Synchronizer

A simple web tool to synchronize your past Nostr events (notes, long-form posts, mentions, etc.) across the specific relays defined in your current NIP-65 list (kind:10002 event).

## Goal

This tool aims to help users ensure consistency for their Nostr presence across their chosen set of relays, adhering to the principles of the NIP-65 Outbox Model. It allows you to backfill your history to newly added relays or ensure older relays have your complete relevant history *as defined by your current NIP-65*.

## Key Features

*   **NIP-65 Based:** Strictly uses the Write and Read relays defined in your *latest* kind:10002 event.
*   **Client-Side & Secure:** Operates **entirely in your browser**. It **never asks for, handles, or stores your private key (nsec/hex)**. All communication happens directly between your browser and the Nostr relays.
*   **Targeted Synchronization:**
    *   Syncs your authored content (e.g., kind:1 Notes, kind:30023 Long-Form Posts) to your designated **Write Relays**.
    *   Syncs events mentioning you (e.g., kind:1 Notes, kind:6 Reposts, kind:7 Reactions, kind:9735 Zaps targeting your pubkey) to your designated **Read Relays**.
*   **Strict Error Handling:** Prioritizes accuracy over partial completion. Stops immediately if an error occurs during fetching or publishing.
*   **Resource-Conscious:** Enforces a relay limit to encourage efficient network usage aligned with the Outbox Model.

## How it Works

1.  Enter your `npub` or `nprofile`.
2.  The tool fetches your latest NIP-65 (kind:10002) event to identify your designated Write and Read relays.
3.  It displays the target relays for both Write and Read sync sections.
4.  Click "Start Write Relay Sync" or "Start Read Relay Sync".
5.  The tool fetches past events (based on the section's filter) in batches from the target relays.
6.  For each fetched event, it checks (using `nostr-tools`'s `seenOn` map) which target relays already have it.
7.  It attempts to publish the event *only* to the target relays that are missing it.
8.  The process continues backward in time until completion or an error occurs.

## Running Locally (Self-Hosting)

While this tool is designed to be safe to use directly online (as it never handles private keys), you can easily run it locally if you prefer:

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd <repository-folder>
    ```
2.  **Install dependencies:**
    ```bash
    # Using npm
    npm install
    # Or using yarn
    yarn install
    # Or using bun
    bun install
    ```
3.  **Start the development server:**
    ```bash
    # Using npm
    npm start
    # Or using yarn
    yarn start
    # Or using bun
    bun start
    ```
4.  Open your browser to the local address provided (usually `http://localhost:3000`).

## Understanding the Relay Limit (Why Max 5?)

*   **What is the Outbox Model (NIP-65)?** NIP-65 allows users to publicly advertise *where* others should publish events *for* them (Write Relays, e.g., your notes) and *where* others should look for events *about* them (Read Relays, e.g., replies/mentions). This standard avoids the need for clients to randomly guess relays or connect to hundreds of them.
*   **Why Limit?** Connecting to too many relays wastes resources – your bandwidth and battery, others' bandwidth, and relay operator storage and bandwidth. The Outbox Model works best when users maintain a small, reliable set of relays (e.g., 3-5 write, 3-5 read).
*   **The Limit:** To encourage efficient network usage aligned with NIP-65, this tool **disables the sync button if you have more than 5 Write Relays or 5 Read Relays** defined in your NIP-65 list. A warning message will explain this.
*   **Flexibility:** Since this is open-source, if you have a specific reason to sync to more relays, you can easily modify the `MAX_WRITE_RELAYS` and `MAX_READ_RELAYS` constants in the source code (`src/components/constant.ts` likely) when running locally.

## Scope and Limitations

*   **Current NIP-65 Only:** This tool synchronizes events **only** to the relays listed in your **current** NIP-65 list.
*   **No Historical Recovery:** It **does not** attempt to find your past events on relays *not* currently in your NIP-65 list (e.g., relays you used previously but removed, or popular public relays). Its purpose is **consistency across your *currently defined* relay set**, not data archaeology.

## Error Handling Philosophy

*   **Strictness First:** The primary goal is **accurate synchronization**.
*   **Stop on Failure:** If the tool encounters an error during the process – fetching events from relays (e.g., timeout, unexpected closure) or publishing an event to a target relay (e.g., connection issue, rate limit, rejection) – it will **immediately stop the sync process** for that section (Write or Read) and display an error.
*   **No Skipping:** It **does not** skip problematic events or relays to continue. This ensures you are aware of potential inconsistencies rather than assuming a partial sync is complete.
*   **Disclaimer:** While designed to be robust, network conditions can be unpredictable, and bugs may exist. **Perfect synchronization cannot be guaranteed in all situations.**

## **Important Warning: Relay Bans & Policies**

*   **Risk of Being Banned:** Republishing a large number of past events, especially very old ones, can be seen as spammy behavior by some relay operators and **may result in your pubkey being temporarily or permanently banned** from their relay.
*   **Rate Limiting:** This tool includes delays between event publications (approx. 5 seconds) and batch fetches (approx. 10 seconds) to mitigate this risk, but **these delays do not guarantee protection against bans**, especially if a relay has strict policies or is under heavy load. Relay operator decisions can sometimes seem arbitrary ("hysterical").
*   **Old Event Restrictions:** Many relays are configured to **reject events with timestamps that are too far in the past**. Attempting to sync very old history might fail for this reason on many public relays.
*   **Recommendation for Deep History Sync:** If you need to synchronize a very large or very old history, it is **strongly recommended** to configure your NIP-65 list to use **only relays that explicitly permit this behavior** (e.g., paid relays with archival features, or your own private relays). Since this tool stops on the first error, even one rejecting relay will halt the entire process for that section.
*   **No Responsibility:** The developers of this tool **are not responsible** if your pubkey gets banned from any relay as a result of using this tool. Use with caution and understand the policies of the relays you choose.

## Disclaimer

This is an experimental tool provided as-is. Use it at your own risk. The developers are not responsible for inconsistencies, relay bans, or other issues arising from its use. 
