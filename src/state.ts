import { config } from './config.js';
import { getText, putText } from './storage.js';

const STATE_KEY = 'state/feeds.json';

export interface FeedCursor {
  lastPublishedIso: string;
}

export type State = Record<string, FeedCursor>;

export async function loadState(): Promise<State> {
  const raw = await getText(config.storage.buckets.raw, STATE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as State;
  } catch {
    return {};
  }
}

export async function saveState(state: State): Promise<void> {
  await putText(
    config.storage.buckets.raw,
    STATE_KEY,
    JSON.stringify(state, null, 2),
    'application/json; charset=utf-8',
  );
}
