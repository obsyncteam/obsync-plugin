export class EchoSuppression {
  private readonly suppressedPaths = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  suppress(path: string): void {
    this.suppressedPaths.set(path, Date.now() + this.ttlMs);
  }

  shouldSuppress(path: string): boolean {
    this.cleanup();
    const expiresAt = this.suppressedPaths.get(path);
    if (!expiresAt) return false;
    return expiresAt > Date.now();
  }

  clear(): void {
    this.suppressedPaths.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [path, expiresAt] of this.suppressedPaths.entries()) {
      if (expiresAt <= now) {
        this.suppressedPaths.delete(path);
      }
    }
  }
}
