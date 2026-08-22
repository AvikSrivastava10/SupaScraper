import type { ScrapedRecord } from "@supascraper/shared";

import type {
  ContractEvaluation,
  DataContract,
} from "../contracts/data-contract.js";
import type { NormalizedRunResult } from "../contracts/collector-run.js";
import { compareToBaseline, describeDiff } from "./compare-baseline.js";

export type DetectionClassification =
  | "healthy"
  | "legitimate_change"
  | "structural_break"
  | "transient_error"
  | "ambiguous";

export type RecommendedAction = "publish" | "retry" | "heal" | "manual_review";

export interface DetectionDecision {
  readonly classification: DetectionClassification;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly source: "deterministic" | "deterministic_with_llm";
  readonly recommendedAction: RecommendedAction;
}

function summarize(messages: readonly string[], limit = 3): string[] {
  const unique = [...new Set(messages)];
  const shown = unique.slice(0, limit);
  if (unique.length > limit) {
    shown.push(`and ${String(unique.length - limit)} more`);
  }
  return shown;
}

/**
 * Deterministic classification, evaluated in a deliberate order.
 *
 * The ordering matters more than the individual rules: a transport failure must
 * never be mistaken for a structural break, because healing a scraper that
 * simply could not reach its page would rewrite working extraction logic
 * against an error page.
 */
export function classifyRun(
  run: NormalizedRunResult,
  evaluation: ContractEvaluation,
  /** Last verified data, used to tell a real change from a broken extraction. */
  baseline: readonly ScrapedRecord[] | null = null,
  /** Supplies the identity field that makes a row-level diff possible. */
  contract: DataContract | null = null,
): DetectionDecision {
  // 1. The run itself did not complete. This is transport, never structure.
  if (run.status !== "succeeded") {
    const retryable = run.safeError?.retryable === true;
    return {
      classification: retryable ? "transient_error" : "ambiguous",
      confidence: retryable ? 0.95 : 0.6,
      evidence: [run.safeError?.message ?? `Collector run ended as ${run.status}.`],
      source: "deterministic",
      recommendedAction: retryable ? "retry" : "manual_review",
    };
  }

  // 2. The run completed but carried per-row extraction failures.
  if (run.extractionErrors.length > 0) {
    const kinds = new Set(run.extractionErrors.map((error) => error.kind));
    const evidence = summarize(run.extractionErrors.map((error) => error.message));

    if (kinds.has("selector_timeout")) {
      return {
        classification: "structural_break",
        confidence: 0.95,
        evidence: [
          "The page loaded but extraction no longer matches it.",
          ...evidence,
        ],
        source: "deterministic",
        recommendedAction: "heal",
      };
    }

    if (kinds.has("unreachable_page")) {
      return {
        classification: "ambiguous",
        confidence: 0.8,
        evidence: [
          "The target page could not be loaded, so healing would not help.",
          ...evidence,
        ],
        source: "deterministic",
        recommendedAction: "manual_review",
      };
    }

    return {
      classification: "ambiguous",
      confidence: 0.5,
      evidence: ["Unrecognized extraction failure.", ...evidence],
      source: "deterministic",
      recommendedAction: "manual_review",
    };
  }

  // 3. A clean run that produced nothing is suspicious, but with no error to
  //    attribute it to there is not enough evidence to rewrite the scraper.
  if (run.records.length === 0) {
    return {
      classification: "ambiguous",
      confidence: 0.6,
      evidence: ["The run succeeded but returned no rows and no error."],
      source: "deterministic",
      recommendedAction: "manual_review",
    };
  }

  // 4. Rows exist but violate the contract: the shape changed under us.
  if (!evaluation.valid) {
    return {
      classification: "structural_break",
      confidence: 0.9,
      evidence: summarize(evaluation.violations.map((violation) => violation.message)),
      source: "deterministic",
      recommendedAction: "heal",
    };
  }

  const satisfied = `All ${String(evaluation.metrics.validRowCount)} row(s) satisfy the expected contract.`;

  // 5. Valid output, but with nothing to compare against there is no basis for
  //    calling it changed.
  if (baseline === null || baseline.length === 0) {
    return {
      classification: "healthy",
      confidence: 1,
      evidence: [satisfied],
      source: "deterministic",
      recommendedAction: "publish",
    };
  }

  // 6. A large drop in rows passes the contract yet is not trustworthy: partial
  //    extraction looks valid while quietly losing most of the catalog.
  if (evaluation.acceptedRecords.length * 2 < baseline.length) {
    return {
      classification: "ambiguous",
      confidence: 0.7,
      evidence: [
        `Row count fell from ${String(baseline.length)} to ${String(evaluation.acceptedRecords.length)}, which is more than half.`,
        "The rows that remain are valid, so this may be partial extraction rather than a real change.",
      ],
      source: "deterministic",
      recommendedAction: "manual_review",
    };
  }

  // 7. Valid output that differs from history: the site's data moved, and the
  //    scraper is doing its job. Publish it.
  const diff = compareToBaseline(baseline, evaluation.acceptedRecords, contract);
  if (diff.hasChanges) {
    return {
      classification: "legitimate_change",
      confidence: 0.9,
      evidence: [
        "Values changed while the structure stayed valid.",
        ...describeDiff(diff),
      ],
      source: "deterministic",
      recommendedAction: "publish",
    };
  }

  return {
    classification: "healthy",
    confidence: 1,
    evidence: [satisfied, "No change since the last verified run."],
    source: "deterministic",
    recommendedAction: "publish",
  };
}
