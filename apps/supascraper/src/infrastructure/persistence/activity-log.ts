import type {
  PipelineStep,
  ProgressReporter,
} from "../../domain/progress/pipeline-step.js";

/** Steps kept per target. Enough for one build plus one repair with room over. */
const MAX_STEPS = 40;

/**
 * Records what is happening to each target, for display.
 *
 * Held in memory on purpose. These steps answer "what is happening now", and a
 * restart means nothing is happening any more, so persisting them would only
 * preserve a stale claim. Verified data, contracts, and repair history are
 * durable; live progress is not.
 */
export class InMemoryActivityLog {
  readonly #steps = new Map<string, PipelineStep[]>();

  /** Starts a fresh sequence, so the display shows this attempt and not a history. */
  begin(targetId: string): void {
    this.#steps.set(targetId, []);
  }

  record(targetId: string, step: PipelineStep): void {
    const existing = this.#steps.get(targetId) ?? [];
    const next = [...existing, step];
    this.#steps.set(targetId, next.slice(Math.max(0, next.length - MAX_STEPS)));
  }

  list(targetId: string): readonly PipelineStep[] {
    return this.#steps.get(targetId) ?? [];
  }

  /** A reporter bound to one target, safe to hand to the application layer. */
  reporterFor(targetId: string): ProgressReporter {
    return (step) => {
      this.record(targetId, { ...step, at: new Date().toISOString() });
    };
  }
}
