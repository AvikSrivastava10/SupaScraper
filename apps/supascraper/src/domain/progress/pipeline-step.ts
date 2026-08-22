/**
 * The steps a site passes through, in the order they happen.
 *
 * These exist so the work is observable while it runs. A collector build takes
 * minutes and a repair takes longer, and without named steps the dashboard can
 * only show a spinner and then a verdict, which tells the reader nothing about
 * what was actually done on their behalf.
 */
export const PIPELINE_STAGES = [
  "validate",
  "build_scraper",
  "collect",
  "read_output",
  "check_contract",
  "classify",
  "learn_contract",
  "publish",
  "heal",
  "review_fix",
  "apply_fix",
  "verify",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * `skipped` is deliberately distinct from `done`.
 *
 * "Data was not published" and "data was published" must never look alike, and a
 * step that was correctly not taken is not a step that succeeded.
 */
export type StepStatus = "started" | "done" | "failed" | "skipped";

export interface PipelineStep {
  readonly stage: PipelineStage;
  readonly status: StepStatus;
  readonly detail: string;
  readonly at: string;
}

/** Reports one step. Implementations must never throw into the caller. */
export type ProgressReporter = (
  step: Omit<PipelineStep, "at">,
) => void;

/** Used wherever progress is not being observed. */
export const NO_PROGRESS: ProgressReporter = () => undefined;

/**
 * Wraps a reporter so a reporting failure cannot break the run it describes.
 *
 * Observability is worth having, but never at the cost of the work itself.
 */
export function safeReporter(report: ProgressReporter): ProgressReporter {
  return (step) => {
    try {
      report(step);
    } catch {
      // Losing a progress line is acceptable; losing the run is not.
    }
  };
}
