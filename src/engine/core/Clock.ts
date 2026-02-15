export class Clock {
  private previousTimeMs: number | null = null;

  public tick(currentTimeMs: number): number {
    if (this.previousTimeMs === null) {
      this.previousTimeMs = currentTimeMs;
      return 0;
    }

    const deltaMs = currentTimeMs - this.previousTimeMs;
    this.previousTimeMs = currentTimeMs;

    const clampedDeltaMs = Math.min(Math.max(deltaMs, 0), 100);
    return clampedDeltaMs / 1000;
  }

  public reset(): void {
    this.previousTimeMs = null;
  }
}
