/**
 * Opt-in, anonymous usage counts. Off until the person turns it on in Settings.
 * Sends an event name, a random install id and the app version: no addresses,
 * no tab ids, no amounts.
 */
import { api } from './api.js';
import { APP_VERSION } from './config.js';
import { readJson, writeJson } from './storage.js';

export type MetricEvent =
  | 'app_opened'
  | 'wallet_connected'
  | 'tab_created'
  | 'tab_joined'
  | 'expense_recorded'
  | 'share_accepted'
  | 'share_declined'
  | 'payment_started'
  | 'payment_submitted'
  | 'payment_confirmed'
  | 'payment_declined';

const CONSENT = 'tally.v2.metricsConsent';
const INSTALL = 'tally.v2.installId';

export function metricsConsent(): boolean {
  return readJson<boolean>(CONSENT) === true;
}

export function setMetricsConsent(on: boolean): void {
  writeJson(CONSENT, on);
}

function installId(): string {
  let id = readJson<string>(INSTALL);
  if (!id) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    writeJson(INSTALL, id);
  }
  return id;
}

export function track(event: MetricEvent): void {
  if (!metricsConsent()) return;
  api.consentedEvent(event, installId(), APP_VERSION).catch((e: unknown) => console.debug('[tally] usage event not sent', e));
}
