import { randomUUID } from "node:crypto";

import type { CatalogRecord } from "@supascraper/shared";

import {
  evaluateCatalogContract,
  type ContractEvaluation,
} from "../../domain/contracts/catalog-contract.js";
import type { NormalizedRunResult } from "../../domain/contracts/collector-run.js";
import {
  classifyRun,
  type DetectionDecision,
} from "../../domain/detection/classify-run.js";
import type { RepairEvent } from "../../domain/repair/repair-event.js";

export interface CatalogDataStore {
  saveLastKnownGood(
    collectorId: string,
    records: readonly CatalogRecord[],
    collectedAt: string,
  ): Promise<void>;
}

export interface RepairEventStore {
  appendEvent(event: RepairEvent): Promise<void>;
}

export interface ProcessRunResult {
  readonly decision: DetectionDecision;
  readonly evaluation: ContractEvaluation;
  readonly published: boolean;
}

export async function processCollectorRun(
  run: NormalizedRunResult,
  dataStore: CatalogDataStore,
  eventStore: RepairEventStore,
): Promise<ProcessRunResult> {
  const evaluation = evaluateCatalogContract(run.records);
  const decision = classifyRun(run, evaluation);
  const published = decision.recommendedAction === "publish" && evaluation.valid;

  if (published) {
    await dataStore.saveLastKnownGood(
      run.collectorId,
      evaluation.acceptedRecords,
      run.finishedAt,
    );
  }

  const now = new Date().toISOString();
  await eventStore.appendEvent({
    id: randomUUID(),
    collectorId: run.collectorId,
    targetUrl: run.targetUrl,
    state: published ? "healthy" : "suspected",
    classification: decision.classification,
    confidence: decision.confidence,
    evidence: decision.evidence,
    beforeMetrics: evaluation.metrics,
    afterMetrics: null,
    healPrompt: null,
    commandOutcome: null,
    verification: "not_started",
    createdAt: now,
    updatedAt: now,
  });

  return { decision, evaluation, published };
}
