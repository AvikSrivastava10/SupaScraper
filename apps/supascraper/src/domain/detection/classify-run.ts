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

export function classifyRun(
  run: NormalizedRunResult,
  evaluation: ContractEvaluation,
): DetectionDecision {
  if (run.status !== "succeeded") {
    return {
      classification: run.safeError?.retryable ? "transient_error" : "ambiguous",
      confidence: run.safeError?.retryable ? 0.95 : 0.6,
      evidence: [run.safeError?.message ?? `Collector run ended as ${run.status}.`],
      source: "deterministic",
      recommendedAction: run.safeError?.retryable ? "retry" : "manual_review",
    };
  }

  if (!evaluation.valid) {
    return {
      classification: "structural_break",
      confidence: 0.9,
      evidence: evaluation.violations.map((violation) => violation.message),
      source: "deterministic",
      recommendedAction: "heal",
    };
  }

  return {
    classification: "healthy",
    confidence: 1,
    evidence: ["Collector output satisfies the configured catalog contract."],
    source: "deterministic",
    recommendedAction: "publish",
  };
}
