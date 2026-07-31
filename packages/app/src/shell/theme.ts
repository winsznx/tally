/**
 * Theme: prefers-color-scheme by default, an explicit toggle overrides and
 * persists. The design ships two token sets — `.tka` (dark) and `.tkl` (light);
 * this toggles the class on the root and remembers the choice.
 */
export type Theme = 'light' | 'dark';
const KEY = 'tally.theme';

export interface ThemeStore {
  get(): Theme | null;
  set(t: Theme): void;
}

export class LocalThemeStore implements ThemeStore {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined) {}
  get(): Theme | null {
    const v = this.storage?.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  }
  set(t: Theme): void {
    this.storage?.setItem(KEY, t);
  }
}

/**
 * Nimiq Pay is LIGHT-ONLY, so Tally defaults to light regardless of the device's
 * prefers-color-scheme. Established from converging official sources:
 *   - every official Pay screenshot is light (App Store, Google Play, and the
 *     nimiq/nimpay-website repo — whose own site is meticulously dual-themed via
 *     CSS light-dark(), so its maintainers would have shipped a dark pair if one
 *     existed; there is exactly one variant of each, and it is light);
 *   - 25 versions of Pay release notes mention no theme/dark/appearance at all;
 *   - the official mini-app docs and Nimiq's own mini-apps skill contain zero
 *     theming guidance.
 *
 * The decisive point for us: `NimiqPayHostContext` exposes `language` and
 * `userFiat` but NO theme signal. So `prefers-color-scheme` would key off the
 * DEVICE OS, not the host — a user with system dark mode would get a dark mini
 * app inside light Nimiq Pay chrome, the worst possible outcome for the scored
 * "feels native on a phone" criterion.
 *
 * The explicit toggle still overrides this and persists.
 */
export const HOST_IS_LIGHT_ONLY = true;

/** The effective theme: the persisted choice if any, else the host default. */
export function resolveTheme(store: ThemeStore, prefersDark: boolean): Theme {
  const chosen = store.get();
  if (chosen) return chosen;
  return HOST_IS_LIGHT_ONLY ? 'light' : prefersDark ? 'dark' : 'light';
}

export function applyTheme(root: { classList: { add(c: string): void; remove(c: string): void } }, theme: Theme): void {
  const [on, off] = theme === 'dark' ? ['tka', 'tkl'] : ['tkl', 'tka'];
  root.classList.add(on);
  root.classList.remove(off);
}

export function toggleTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}
