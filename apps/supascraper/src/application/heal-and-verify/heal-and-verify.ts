import { evaluateCatalogContract } from "../../domain/contracts/catalog-contract.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../../domain/contracts/collector-run.js";
import type { DetectionDecision } from "../../domain/detection/classify-run.js";
import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";
import { transitionState } from "../../domain/state-machine/state-machine.js";
import type { CatalogDataStore } from "../process-run/process-run.js";
import type { CollectorRunner } from "../run-collector/run-collector.js";

/**
 * Mirrors the envelope that CLI 0.3.5 `scraper heal` returns. The command stops
 * at an approval gate by default, so `status` reports whether the gate was
 * reached rather than whether the scraper was repaired.
 */
export interface HealEnvelope {
  readonly status: string;
  readonly completedSteps: readonly string[];
  readonly previewResult: unknown;
  readonly diffSummary: string | null;
  readonly safeMessage: string;
}

export interface CollectorHealer {
  heal(collectorId: string, prompt: string): Promise<HealEnvelope>;
}

export interface CollectorApprover {
  approve(collectorId: string): Promise<void>;
  reject(collectorId: string): Promise<void>;
}

export interface PreviewReview {
  readonly plausible: boolean;
  readonly evidence: readonly string[];
}

/**
 * Judges the pending fix from the heal envelope before it is committed. A
 * preview that merely parses is not acceptable; it must satisfy the same
 * contract the collector is expected to produce.
 */
export interface HealPreviewReviewer {
  review(envelope: HealEnvelope, config: CollectorConfig): PreviewReview;
}

export interface CollectorLock {
  acquire(collectorId: string): Promise<string | null>;
  release(collectorId: string, token: string): Promise<void>;
}

export interface HealAndVerifyInput {
  readonly config: CollectorConfig;
  readonly decision: DetectionDecision;
  readonly healPrompt: string;
}

export type HealAndVerifyStatus =
  | "recovered"
  | "manual_review"
  | "already_in_progress";

export interface HealAndVerifyOutcome {
  readonly status: HealAndVerifyStatus;
  readonly finalState: OrchestrationState;
  readonly envelope: HealEnvelope | null;
  readonly review: PreviewReview | null;
  readonly verificationRun: NormalizedRunResult | null;
  readonly reason: string;
}

export interface HealAndVerifyDependencies {
  readonly healer: CollectorHealer;
  readonly approver: CollectorApprover;
  readonly reviewer: HealPreviewReviewer;
  readonly runner: CollectorRunner;
  readonly dataStore: CatalogDataStore;
  readonly lock: CollectorLock;
}

/** The heal envelope statuses that mean the fix is pending human or automated review. */
const APPROVAL_GATE_STATUSES = new Set([
  "awaiting_approval",
  "awaiting-approval",
  "pending_approval",
]);

function reachedApprovalGate(envelope: HealEnvelope): boolean {
  return APPROVAL_GATE_STATUSES.has(envelope.status.trim().toLowerCase());
}

/**
 * Drives a confirmed structural break through Bright Data's repair flow.
 *
 * The sequence is deliberately `healing → awaiting_approval → verifying`. A
 * completed heal command is never treated as a repair, and an approved fix is
 * never treated as a recovery: only a fresh run of the same collector that
 * satisfies the original contract may publish data.
 */
export async function healAndVerify(
  input: HealAndVerifyInput,
  dependencies: HealAndVerifyDependencies,
): Promise<HealAndVerifyOutcome> {
  const { healer, approver, reviewer, runner, dataStore, lock } = dependencies;

  if (
    input.decision.classification !== "structural_break" ||
    input.decision.recommendedAction !== "heal"
  ) {
    throw new Error("Only a confirmed structural break may enter healing.");
  }

  const lockToken = await lock.acquire(input.config.collectorId);
  if (lockToken === null) {
    return {
      status: "already_in_progress",
      finalState: "healing",
      envelope: null,
      review: null,
      verificationRun: null,
      reason: "Another repair is already in progress for this collector.",
    };
  }

  let state: OrchestrationState = transitionState("suspected", "healing");

  try {
    const envelope = await healer.heal(
      input.config.collectorId,
      input.healPrompt,
    );

    if (!reachedApprovalGate(envelope)) {
      return {
        status: "manual_review",
        finalState: transitionState(state, "manual_review"),
        envelope,
        review: null,
        verificationRun: null,
        reason: `Heal did not reach the approval gate; status was "${envelope.status}".`,
      };
    }

    state = transitionState(state, "awaiting_approval");

    const review = reviewer.review(envelope, input.config);
    if (!review.plausible) {
      await approver.reject(input.config.collectorId);
      return {
        status: "manual_review",
        finalState: transitionState(state, "manual_review"),
        envelope,
        review,
        verificationRun: null,
        reason: "Proposed fix was rejected as implausible.",
      };
    }

    await approver.approve(input.config.collectorId);
    state = transitionState(state, "verifying");

    // Approval commits the change. Recovery still has to be earned by a run.
    const verificationRun = await runner.run(input.config);
    const evaluation = evaluateCatalogContract(verificationRun.records);
    const sameCollector =
      verificationRun.collectorId === input.config.collectorId &&
      verificationRun.targetUrl === input.config.targetUrl;

    if (!sameCollector) {
      return {
        status: "manual_review",
        finalState: transitionState(state, "manual_review"),
        envelope,
        review,
        verificationRun,
        reason:
          "Verification run did not target the same collector and URL as the original.",
      };
    }

    if (verificationRun.status !== "succeeded" || !evaluation.valid) {
      return {
        status: "manual_review",
        finalState: transitionState(state, "manual_review"),
        envelope,
        review,
        verificationRun,
        reason:
          "Verification run did not satisfy the expected data contract after healing.",
      };
    }

    await dataStore.saveLastKnownGood(
      input.config.collectorId,
      evaluation.acceptedRecords,
      verificationRun.finishedAt,
    );

    return {
      status: "recovered",
      finalState: transitionState(state, "recovered"),
      envelope,
      review,
      verificationRun,
      reason: "Same collector recovered the original data contract.",
    };
  } finally {
    await lock.release(input.config.collectorId, lockToken);
  }
}

/**
 * Deterministic preview review: the preview must be a record array that
 * satisfies the catalog contract. Used before any LLM opinion is consulted.
 */
export class ContractPreviewReviewer implements HealPreviewReviewer {
  review(envelope: HealEnvelope): PreviewReview {
    const preview = envelope.previewResult;

    if (!Array.isArray(preview)) {
      return {
        plausible: false,
        evidence: ["Heal preview did not contain a record array."],
      };
    }

    const evaluation = evaluateCatalogContract(preview);
    if (!evaluation.valid) {
      return {
        plausible: false,
        evidence: evaluation.violations.map((violation) => violation.message),
      };
    }

    return {
      plausible: true,
      evidence: [
        `Preview satisfies the catalog contract across ${String(evaluation.metrics.validRowCount)} record(s).`,
      ],
    };
  }
}
