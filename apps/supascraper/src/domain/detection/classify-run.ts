import type { ContractEvaluation } from "../contracts/catalog-contract.js";
import type { NormalizedRunResult } from "../contracts/collector-run.js";

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

  return {
    classification: "healthy",
    confidence: 1,
    evidence: [
      `All ${String(evaluation.metrics.validRowCount)} row(s) satisfy the expected contract.`,
    ],
    source: "deterministic",
    recommendedAction: "publish",
  };
}
