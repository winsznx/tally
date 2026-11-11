/**
 * Tabs this device has opened. Kept on the device only: a server-side "tabs for
 * address" lookup would let anyone who knows your address read your tabs.
 */
import { readJson, writeJson } from './storage.js';

export interface KnownTab {
  tabId: string;
  name: string;
  lastOpenedAt: number;
}

const KEY = 'tally.v2.tabs';
const DISPLAY_NAME = 'tally.v2.displayName';

export function knownTabs(): KnownTab[] {
  return (readJson<KnownTab[]>(KEY) ?? []).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function rememberTab(tabId: string, name: string): void {
  const rest = knownTabs().filter((t) => t.tabId !== tabId);
  writeJson(KEY, [{ tabId, name, lastOpenedAt: Date.now() }, ...rest]);
}

export function forgetTab(tabId: string): void {
  writeJson(
    KEY,
    knownTabs().filter((t) => t.tabId !== tabId),
  );
}

export function preferredDisplayName(): string {
  return readJson<string>(DISPLAY_NAME) ?? '';
}

export function setPreferredDisplayName(name: string): void {
  writeJson(DISPLAY_NAME, name);
}

export const TAB_ID_RE = /^[a-z2-7]{26}$/;
