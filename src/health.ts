// Decides when to tell you that Session can't be reached, and when it works again.
// Pure logic (no timers, no I/O) so it can be tested with a fake clock.

export type HealthEvent =
  | { type: "alert"; downMs: number }
  | { type: "remind"; downMs: number }
  | { type: "recovered"; downMs: number };

export class Health {
  private downSince: number | undefined;
  private alerted = false;
  private lastNotice = 0;
  private lastTick = 0;

  constructor(
    private opts: {
      /** Tell the user after this much continuous trouble. 0 turns alerts off. */
      alertAfterMs: number;
      /** While the trouble goes on, remind the user this often. */
      remindEveryMs: number;
      /** A pause between ticks longer than this means the computer was asleep. */
      sleepGapMs: number;
    },
  ) {}

  /** Call regularly. `down` is true while Session can't be reached. */
  tick(down: boolean, now: number): HealthEvent | undefined {
    const gap = this.lastTick ? now - this.lastTick : 0;
    this.lastTick = now;
    if (this.opts.alertAfterMs <= 0) return undefined;

    // Time the computer spent asleep isn't an outage: take it out of the clock.
    if (gap > this.opts.sleepGapMs && this.downSince !== undefined) {
      this.downSince += gap;
      this.lastNotice += gap;
    }

    if (down) {
      if (this.downSince === undefined) this.downSince = now;
      const downMs = now - this.downSince;
      if (!this.alerted && downMs >= this.opts.alertAfterMs) {
        this.alerted = true;
        this.lastNotice = now;
        return { type: "alert", downMs };
      }
      if (this.alerted && now - this.lastNotice >= this.opts.remindEveryMs) {
        this.lastNotice = now;
        return { type: "remind", downMs };
      }
      return undefined;
    }

    const since = this.downSince;
    this.downSince = undefined;
    if (this.alerted && since !== undefined) {
      this.alerted = false;
      return { type: "recovered", downMs: now - since };
    }
    this.alerted = false;
    return undefined;
  }
}

/**
 * How long to wait before the next Session poll. After a failure the bridge retries
 * quickly (3s, 6s, 12s, 24s, then every 30s) instead of waiting a long time, because
 * most failures are one slow Session node or one bad Tor circuit.
 */
export function pollDelay(consecutiveFailures: number, normalMs: number): number {
  if (consecutiveFailures <= 0) return normalMs;
  return Math.min(3000 * 2 ** (consecutiveFailures - 1), 30_000);
}

export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 6) / 10;
  return `${h} h`;
}
