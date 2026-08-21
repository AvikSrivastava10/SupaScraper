import { randomUUID } from "node:crypto";

import type { CatalogRecord } from "@supascraper/shared";

import {
  evaluateCatalogContract,
  type ContractEvaluation,
} from "../../domain/contracts/catalog-contract.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../../domain/contracts/collector-run.js";
import {
  classifyRun,
  type DetectionDecision,
} from "../../domain/detection/classify-run.js";
import { buildHealPrompt } from "../../domain/repair/heal-prompt.js";
import type { RepairEvent, VerificationStatus } from "../../domain/repair/repair-event.js";
import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";
import type {
  HealAndVerifyDependencies,
  HealAndVerifyOutcome,
} from "../heal-and-verify/heal-and-verify.js";
import { healAndVerify } from "../heal-and-verify/heal-and-verify.js";

export interface CatalogDataStore {
  saveLastKnownGood(
    collectorId: string,
    records: readonly CatalogRecord[],
    collectedAt: string,
  ): Promise<void>;
  getLastKnownGood(
    collectorId: string,
  ): Promise<{ readonly records: readonly CatalogRecord[] } | null>;
}

export interface RepairEventStore {
  appendEvent(event: RepairEvent): Promise<void>;
}

export interface ProcessRunResult {
  readonly decision: DetectionDecision;
  readonly evaluation: ContractEvaluation;
  readonly published: boolean;
  readonly repair: HealAndVerifyOutcome | null;
  readonly state: OrchestrationState;
}

/**
 * Minimum confidence before a repair may be attempted without a human.
 *
 * Deterministic structural detection reports 0.9 or above, so this admits a
 * confident break while still refusing anything the detector is unsure about.
 */
export const AUTO_HEAL_CONFIDENCE_THRESHOLD = 0.85;

export interface ProcessRunOptions {
  /** Off by default: healing mutates a hosted collector and spends credit. */
  readonly autoHealEnabled?: boolean;
  readonly config?: CollectorConfig;
  readonly repair?: HealAndVerifyDependencies;
}

function stateFor(
  decision: DetectionDecision,
  published: boolean,
  repair: HealAndVerifyOutcome | null,
): OrchestrationState {
  if (repair !== null) {
    return repair.finalState;
  }
  if (published) {
    return "healthy";
  }
  switch (decision.recommendedAction) {
    case "retry":
      return "retry_or_wait";
    case "manual_review":
      return "manual_review";
    default:
      return "suspected";
  }
}

/**
 * Processes one collector run: validate, classify, publish or withhold, and
 * optionally drive an automatic repair.
 *
 * Publication is gated on the contract, never on the command succeeding, and a
 * repair is only attempted for a confident structural break.
 */
export async function processCollectorRun(
  run: NormalizedRunResult,
  dataStore: CatalogDataStore,
  eventStore: RepairEventStore,
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const evaluation = evaluateCatalogContract(run.records);

  // The previously verified data is the only reference that can distinguish a
  // real data change from a partially broken extraction.
  const previous = await dataStore.getLastKnownGood(run.collectorId);
  const decision = classifyRun(run, evaluation, previous?.records ?? null);

  const publishable =
    decision.recommendedAction === "publish" && evaluation.valid && run.records.length > 0;

  if (publishable) {
    await dataStore.saveLastKnownGood(
      run.collectorId,
      evaluation.acceptedRecords,
      run.finishedAt,
    );
  }

  let repair: HealAndVerifyOutcome | null = null;
  let healPrompt: string | null = null;

  const mayHeal =
    options.autoHealEnabled === true &&
    options.config !== undefined &&
    options.repair !== undefined &&
    decision.classification === "structural_break" &&
    decision.recommendedAction === "heal" &&
    decision.confidence >= AUTO_HEAL_CONFIDENCE_THRESHOLD;

  if (mayHeal && options.config && options.repair) {
    healPrompt = buildHealPrompt({
      fieldDescription: options.config.fieldDescription,
      run,
      evaluation,
    });

    repair = await healAndVerify(
      { config: options.config, decision, healPrompt },
      options.repair,
    );
  }

  const published = publishable || repair?.status === "recovered";
  const state = stateFor(decision, publishable, repair);

  const verification: VerificationStatus =
    repair === null
      ? "not_started"
      : repair.status === "recovered"
        ? "passed"
        : "failed";

  const afterMetrics =
    repair?.verificationRun === null || repair?.verificationRun === undefined
      ? null
      : evaluateCatalogContract(repair.verificationRun.records).metrics;

  const now = new Date().toISOString();
  await eventStore.appendEvent({
    id: randomUUID(),
    collectorId: run.collectorId,
    targetUrl: run.targetUrl,
    state,
    classification: decision.classification,
    confidence: decision.confidence,
    evidence: repair === null ? decision.evidence : [...decision.evidence, repair.reason],
    beforeMetrics: evaluation.metrics,
    afterMetrics,
    healPrompt,
    commandOutcome: repair?.envelope?.status ?? null,
    verification,
    createdAt: now,
    updatedAt: now,
  });

  return { decision, evaluation, published, repair, state };
}
