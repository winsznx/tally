/**
 * localStorage that degrades instead of throwing. Some WebViews disable storage;
 * Tally then keeps state for the session only and says so, rather than crashing.
 */
const memory = new Map<string, string>();
let persistent: boolean | null = null;

export function storageIsPersistent(): boolean {
  if (persistent !== null) return persistent;
  try {
    const probe = 'tally.v2.probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    persistent = true;
  } catch {
    persistent = false;
  }
  return persistent;
}

export function readRaw(key: string): string | null {
  if (storageIsPersistent()) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  }
  return memory.get(key) ?? null;
}

export function writeRaw(key: string, value: string): void {
  memory.set(key, value);
  if (!storageIsPersistent()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    console.warn('[tally] storage write failed; keeping this value for the session only', e);
  }
}

export function readJson<T>(key: string): T | null {
  const raw = readRaw(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson<T>(key: string, value: T): void {
  writeRaw(key, JSON.stringify(value));
}
