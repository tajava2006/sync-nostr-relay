import { formatDateForInput } from './util';

// Default relays to use if user relay is not found or doesn't provide hints
export const DEFAULT_RELAYS = [
  'wss://hbr.coracle.social/',
  'wss://nos.lol/',
  'wss://purplepag.es/',
  'wss://relay.nostr.band/',
];

export const MAX_WRITE_RELAYS = 5;
export const MAX_READ_RELAYS = 5;

export const DEFAULT_OLDEST_DATE_STR = '1970-01-01T00:00';
export const getDefaultStartDateStr = () => formatDateForInput(new Date());
