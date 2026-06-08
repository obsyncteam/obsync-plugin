export class Debouncer {
  private readonly timers = new Map<string, number>();

  run(key: string, delayMs: number, callback: () => void): void {
    const existing = this.timers.get(key);
    if (existing) {
      window.clearTimeout(existing);
    }

    const next = window.setTimeout(() => {
      this.timers.delete(key);
      callback();
    }, delayMs);

    this.timers.set(key, next);
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
  }
}
