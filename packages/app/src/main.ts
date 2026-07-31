/**
 * Single entry point for the one origin. Detects which half to show
 * SYNCHRONOUSLY (so first paint never waits on the wallet connect timeout) and
 * lazy-loads only that half's bundle.
 */
import { pickHalf } from './shell/origin.js';

const half = pickHalf(window as unknown as { nimiqPay?: unknown; location: { search: string } });

if (half === 'app') {
  void import('./app/mount.js').then((m) => m.mountApp());
} else {
  void import('./landing/mount.js').then((m) => m.mountLanding());
}
