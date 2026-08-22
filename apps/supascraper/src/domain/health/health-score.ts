import type { DataContract } from "../contracts/data-contract.js";
import type { ContractMetrics } from "../contracts/data-contract.js";

/**
 * A component of health, or `null` when there is nothing to judge it against.
 *
 * `null` is used deliberately rather than 0 or 100. A site that has never run has
 * unknown extraction quality, not perfect and not broken, and a dashboard that
 * shows 100% for "no data yet" is lying.
 */
export type Score = number | null;

export interface HealthScore {
  /** Share of returned rows that satisfied the contract. */
  readonly extraction: Score;
  /** Share of contract fields that were present and non-empty in every row. */
  readonly schema: Score;
  /** How current the verified data is, judged against the expected cadence. */
  readonly freshness: Score;
  /** Mean of whichever components could be computed. */
  readonly overall: Score;
  readonly checkedAt: string | null;
}

export interface HealthInput {
  /** Metrics from the most recent recorded run, if there has been one. */
  readonly metrics: ContractMetrics | null;
  readonly contract: DataContract | null;
  readonly collectedAt: string | null;
  /** Expected time between unattended runs. Null means on-demand only. */
  readonly scheduleMinutes: number | null;
  readonly now?: number;
}

export const UNKNOWN_HEALTH: HealthScore = {
  extraction: null,
  schema: null,
  freshness: null,
  overall: null,
  checkedAt: null,
};

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Share of returned rows that were usable.
 *
 * A run that returned nothing scores zero rather than `null`: the collector did
 * report, and it reported no usable data, which is a real result.
 */
function scoreExtraction(metrics: ContractMetrics): number {
  if (metrics.rowCount === 0) {
    return 0;
  }
  return clamp(metrics.validRowCount / metrics.rowCount);
}

/**
 * Share of the contract's fields that held across every row.
 *
 * Counted per field rather than per row, so one field disappearing everywhere
 * reads as a schema problem instead of being averaged away by the fields that
 * still work.
 */
function scoreSchema(metrics: ContractMetrics, contract: DataContract): Score {
  const fields = contract.requiredFields;
  if (fields.length === 0) {
    return null;
  }

  const intact = fields.filter(
    (field) =>
      (metrics.missingByField[field] ?? 0) === 0 &&
      (metrics.nullByField[field] ?? 0) === 0,
  ).length;

  return clamp(intact / fields.length);
}

/**
 * How current the data is, relative to how often it is supposed to be collected.
 *
 * Without a schedule there is no cadence to be late against, so this is `null`
 * rather than a number. Inventing a decay curve for on-demand collection would
 * put a precise-looking figure on a question nobody asked.
 */
function scoreFreshness(
  collectedAt: string | null,
  scheduleMinutes: number | null,
  now: number,
): Score {
  if (collectedAt === null || scheduleMinutes === null) {
    return null;
  }

  const then = Date.parse(collectedAt);
  if (Number.isNaN(then)) {
    return null;
  }

  const interval = scheduleMinutes * 60_000;
  const age = Math.max(0, now - then);

  // Full marks inside one interval, then a straight decline to zero by the third.
  // One missed run is a hiccup; three is stale data being presented as current.
  if (age <= interval) {
    return 1;
  }
  return clamp(1 - (age - interval) / (2 * interval));
}

/**
 * Scores a target's health from what actually happened, never from assumption.
 *
 * Each component is `null` when the evidence for it does not exist, and the
 * overall figure averages only what could be measured. A target with no runs
 * scores nothing at all, which is the honest answer.
 */
export function scoreHealth(input: HealthInput): HealthScore {
  const now = input.now ?? Date.now();

  if (input.metrics === null) {
    return {
      ...UNKNOWN_HEALTH,
      freshness: scoreFreshness(input.collectedAt, input.scheduleMinutes, now),
      checkedAt: null,
    };
  }

  const extraction = scoreExtraction(input.metrics);
  const schema =
    input.contract === null ? null : scoreSchema(input.metrics, input.contract);
  const freshness = scoreFreshness(input.collectedAt, input.scheduleMinutes, now);

  const parts = [extraction, schema, freshness].filter(
    (part): part is number => part !== null,
  );

  return {
    extraction,
    schema,
    freshness,
    overall:
      parts.length === 0
        ? null
        : parts.reduce((total, part) => total + part, 0) / parts.length,
    checkedAt: input.collectedAt,
  };
}

/** Renders a score as a percentage, or a dash when it could not be measured. */
export function formatScore(score: Score): string {
  if (score === null) {
    return "—";
  }
  // Rounded to a whole number: a scraper reporting 99.83% implies a precision the
  // underlying row counts do not have.
  return `${String(Math.round(score * 100))}%`;
}
