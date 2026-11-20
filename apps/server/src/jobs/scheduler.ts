import { notifyFacultyChanged } from "../domain/faculty.js";
import { refreshEventAvailability, runDueIntegrations } from "../domain/integrations.js";
import { refreshAllDoorReservations } from "../domain/reservations.js";
import { runDueSchedules } from "../domain/schedules.js";

/** How often due schedules are looked for. A schedule fires up to this late. */
export const SCHEDULER_TICK_MS = 15_000;
/** Reservations and Faculty content age with the clock, so they are refreshed even when nobody edits anything. */
export const REFRESH_EVERY_MS = 30 * 60_000;

/**
 * Runs the jobs that depend on time. No external queue: schedules live in MongoDB and are claimed with
 * a conditional update, so even two server processes would not run one twice (see `runDueSchedules`).
 */
export function startScheduler() {
  let busy = false;
  const guarded = (name: string, job: () => Promise<unknown>) => async () => {
    if (busy) return; // a slow tick must not pile up behind itself
    busy = true;
    try {
      await job();
    } catch (err) {
      console.error(`${name} failed`, err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };

  const tick = setInterval(
    guarded("scheduler", async () => {
      await runDueSchedules();
      // Portals are read when due; people who have just started or finished an event change status on the screens.
      await runDueIntegrations();
      await refreshEventAvailability();
    }),
    SCHEDULER_TICK_MS,
  );
  const refresh = setInterval(
    guarded("refresh", async () => {
      await refreshAllDoorReservations();
      await notifyFacultyChanged();
    }),
    REFRESH_EVERY_MS,
  );
  tick.unref();
  refresh.unref();
  return () => {
    clearInterval(tick);
    clearInterval(refresh);
  };
}
