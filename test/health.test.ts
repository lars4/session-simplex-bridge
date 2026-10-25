import { Health, pollDelay, formatDuration } from "../src/health.ts";
import { ok, done } from "./util.ts";

const MIN = 60_000;
const mk = () => new Health({ alertAfterMs: 30 * MIN, remindEveryMs: 6 * 60 * MIN, sleepGapMs: 3 * MIN });

// A short outage never alerts; recovery without an alert says nothing.
{
  const h = mk();
  let t = 0;
  let events = 0;
  for (; t < 20 * MIN; t += MIN) if (h.tick(true, t)) events++;
  ok(events === 0, "no alert before the threshold");
  ok(h.tick(false, t) === undefined, "no 'recovered' message when nothing was announced");
}

// Alert once after 30 min, no repeat, then recovered with the duration.
{
  const h = mk();
  const seen: string[] = [];
  let t = 0;
  for (; t <= 45 * MIN; t += MIN) {
    const e = h.tick(true, t);
    if (e) seen.push(`${e.type}@${t / MIN}`);
  }
  ok(seen.join() === "alert@30", "one alert at 30 min: " + seen.join());
  const r = h.tick(false, t);
  ok(r?.type === "recovered" && r.downMs === 46 * MIN, "recovered after the outage: " + JSON.stringify(r));
  ok(h.tick(false, t + MIN) === undefined, "nothing more after recovery");
}

// Reminder every 6 hours while it stays down.
{
  const h = mk();
  const seen: string[] = [];
  for (let t = 0; t <= 13 * 60 * MIN; t += MIN) {
    const e = h.tick(true, t);
    if (e) seen.push(`${e.type}@${t / MIN}`);
  }
  ok(seen.join() === "alert@30,remind@390,remind@750", "reminders every 6 h: " + seen.join());
}

// Computer asleep: the sleeping time is not counted as an outage.
{
  const h = mk();
  h.tick(true, 0);
  h.tick(true, 10 * MIN);
  // sleeps for 8 hours, wakes up still "down" (ticks come once a minute while awake)
  let t = 10 * MIN + 8 * 60 * MIN;
  ok(h.tick(true, t) === undefined, "no alert right after waking from sleep");
  let alertAfter = -1;
  for (let i = 1; i <= 30 && alertAfter < 0; i++) if (h.tick(true, t + i * MIN)?.type === "alert") alertAfter = i;
  ok(alertAfter === 20, "alert after 30 min of awake trouble (10 before sleep + 20 after): " + alertAfter);
}

// A flapping connection (up again before 30 min) restarts the clock.
{
  const h = mk();
  let events = 0;
  for (let t = 0; t < 25 * MIN; t += MIN) if (h.tick(true, t)) events++;
  h.tick(false, 25 * MIN);
  for (let t = 26 * MIN; t < 50 * MIN; t += MIN) if (h.tick(true, t)) events++;
  ok(events === 0, "recovery in between resets the outage clock");
}

// Turned off with 0.
{
  const h = new Health({ alertAfterMs: 0, remindEveryMs: 1, sleepGapMs: 1 });
  let events = 0;
  for (let t = 0; t < 100 * MIN; t += MIN) if (h.tick(true, t)) events++;
  ok(events === 0, "alerts can be turned off");
}

// Poll retry timing.
ok(pollDelay(0, 5000) === 5000, "normal interval when polling works");
ok([1, 2, 3, 4, 5, 6, 20].map((n) => pollDelay(n, 5000)).join() === "3000,6000,12000,24000,30000,30000,30000", "retry backoff 3s…30s");

ok(formatDuration(31 * MIN) === "31 min" && formatDuration(180 * MIN) === "3 h" && formatDuration(1000) === "1 min", "durations read well");
done();
