import type { ClockAdapter } from './types.js';

/** Real wall clock. */
export class SystemClock implements ClockAdapter {
  now(): number {
    return Date.now();
  }
}

/** Settable clock so round-expiry countdowns are testable without waiting. */
export class FakeClock implements ClockAdapter {
  #ms: number;
  constructor(startMs = 0) {
    this.#ms = startMs;
  }
  now(): number {
    return this.#ms;
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
  set(ms: number): void {
    this.#ms = ms;
  }
}
