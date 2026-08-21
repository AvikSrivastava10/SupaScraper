import type { Logger } from "../../infrastructure/logging/logger.js";

/**
 * Lowest permitted interval between scheduled runs.
 *
 * Each run costs Bright Data credit, and a schedule runs unattended after
 * everyone has stopped watching. A floor is safer than trusting configuration:
 * a mistyped value should be rejected, not silently drain the account.
 */
export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;

export interface SchedulerOptions {
  readonly intervalMs: number;
  /** Must reuse the same pipeline and lock as a manual run. */
  readonly trigger: () => Promise<void>;
  readonly logger: Logger;
}

export interface SchedulerHandle {
  readonly intervalMs: number;
  stop(): void;
  /** Exposed for tests; runs one tick without waiting for the timer. */
  tick(): Promise<void>;
}

export function estimatedRunsPerDay(intervalMs: number): number {
  return Math.floor((24 * 60 * 60 * 1000) / intervalMs);
}

/**
 * Runs the collector on a fixed interval.
 *
 * Ticks never overlap: if a run is still in flight when the timer fires, the
 * tick is skipped rather than queued, so a slow repair cannot cause a pile-up
 * of concurrent runs each spending credit.
 */
export function startScheduler(options: SchedulerOptions): SchedulerHandle {
  if (options.intervalMs < MIN_SCHEDULE_INTERVAL_MS) {
    throw new Error(
      `A scheduled interval must be at least ${String(
        MIN_SCHEDULE_INTERVAL_MS / 60_000,
      )} minutes, because every run consumes Bright Data credit.`,
    );
  }

  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) {
      if (running) {
        options.logger.info("Scheduled run skipped: one is still in progress.");
      }
      return;
    }

    running = true;
    try {
      await options.trigger();
    } catch (error) {
      options.logger.error("Scheduled run failed.", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs);

  // Do not hold the process open purely for the schedule.
  timer.unref();

  options.logger.info("Scheduler started.", {
    intervalMinutes: Math.round(options.intervalMs / 60_000),
    estimatedRunsPerDay: estimatedRunsPerDay(options.intervalMs),
  });

  return {
    intervalMs: options.intervalMs,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      options.logger.info("Scheduler stopped.");
    },
    tick,
  };
}
