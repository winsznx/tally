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

/** The effective theme: persisted choice if any, else the system preference. */
export function resolveTheme(store: ThemeStore, prefersDark: boolean): Theme {
  return store.get() ?? (prefersDark ? 'dark' : 'light');
}

export function applyTheme(root: { classList: { add(c: string): void; remove(c: string): void } }, theme: Theme): void {
  const [on, off] = theme === 'dark' ? ['tka', 'tkl'] : ['tkl', 'tka'];
  root.classList.add(on);
  root.classList.remove(off);
}

export function toggleTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}
