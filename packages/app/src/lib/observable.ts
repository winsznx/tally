/** Minimal external store for React's useSyncExternalStore. */
export class Observable<T> {
  #listeners = new Set<() => void>();

  constructor(protected state: T) {}

  get snapshot(): T {
    return this.state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): T => this.state;

  protected set(next: T): void {
    this.state = next;
    for (const l of this.#listeners) l();
  }

  protected patch(partial: Partial<T>): void {
    this.set({ ...this.state, ...partial });
  }
}
