// Time source for scheduling. All due-time comparisons pass the clock's value to SQL as a
// parameter (never now()), so tests drive schedules with a ManualClock deterministically.

export interface Clock { now(): number }

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private t: number) {}
  now() { return this.t; }
  set(t: number | string) { this.t = typeof t === 'string' ? Date.parse(t) : t; }
  advance(ms: number) { this.t += ms; }
}

let active: Clock = systemClock;
/** The clock API handlers use; tests swap it for a ManualClock shared with the Scheduler. */
export const appClock: Clock = { now: () => active.now() };
export function setAppClock(c: Clock | undefined) { active = c ?? systemClock; }
